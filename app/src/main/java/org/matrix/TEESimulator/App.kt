package org.matrix.TEESimulator

import android.app.ActivityThread
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Looper
import java.security.Security
import kotlin.system.exitProcess
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.matrix.TEESimulator.config.BootStateManager
import org.matrix.TEESimulator.config.ConfigurationManager
import org.matrix.TEESimulator.config.LicenseManager
import org.matrix.TEESimulator.interception.keystore.AbstractKeystoreInterceptor
import org.matrix.TEESimulator.interception.keystore.Keystore2Interceptor
import org.matrix.TEESimulator.interception.keystore.KeystoreInterceptor
import org.matrix.TEESimulator.interception.soter.SoterProcessSupervisor
import org.matrix.TEESimulator.logging.SystemLogger
import org.matrix.TEESimulator.pki.NativeCertGen
import org.matrix.TEESimulator.util.AndroidDeviceUtils

object App {
    private const val RETRY_DELAY_MS = 1000L

    @JvmStatic
    fun main(args: Array<String>) {
        SystemLogger.info("Welcome to TEESimulator!")

        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            SystemLogger.error("Uncaught exception on ${thread.name}", throwable)
        }

        try {
            val systemContext = prepareEnvironment()

            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            Security.addProvider(BouncyCastleProvider())

            LicenseManager.verifyOrThrow()

            if (args.contains("--license-preflight")) return

            BootStateManager.apply()

            ConfigurationManager.initialize()

            initializeInterceptors()

            AndroidDeviceUtils.setupBootKeyAndHash()

            NativeCertGen.initialize("/data/adb/modules/tricky_store/libcertgen.so")

            SoterProcessSupervisor.start(systemContext)

            Looper.loop()
        } catch (e: Exception) {
            SystemLogger.error("A fatal error occurred in the main application thread.", e)
            if (LicenseManager.isLicenseFailure(e)) {
                exitProcess(LicenseManager.REJECT_EXIT_CODE)
            }
            throw e
        }
    }

    private fun prepareEnvironment(): Context {
        if (Looper.getMainLooper() == null) {
            @Suppress("deprecation") Looper.prepareMainLooper()
        }

        val activityThread = ActivityThread.systemMain()

        @Suppress("CAST_NEVER_SUCCEEDS")
        val systemContext = activityThread.getSystemContext() as Context

        val app = Application()
        val attachMethod =
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
        attachMethod.isAccessible = true
        attachMethod.invoke(app, systemContext)

        val mInitialApplicationField =
            ActivityThread::class.java.getDeclaredField("mInitialApplication")
        mInitialApplicationField.isAccessible = true
        mInitialApplicationField.set(activityThread, app)

        return systemContext
    }

    private fun initializeInterceptors() {
        val interceptor = selectKeystoreInterceptor()

        while (!interceptor.tryRunKeystoreInterceptor()) {
            SystemLogger.debug("Retrying interceptor initialization...")
            Thread.sleep(RETRY_DELAY_MS)
        }

        SystemLogger.info("Interceptors initialized successfully.")
    }

    private fun selectKeystoreInterceptor(): AbstractKeystoreInterceptor =
        when {
            Build.VERSION.SDK_INT in Build.VERSION_CODES.Q..Build.VERSION_CODES.R -> {
                SystemLogger.info(
                    "Using KeystoreInterceptor for Android Q/R (SDK ${Build.VERSION.SDK_INT})"
                )
                android.security.keystore.AndroidKeyStoreProvider.install()
                KeystoreInterceptor
            }
            else -> {
                SystemLogger.info(
                    "Using Keystore2Interceptor for Android S and later (SDK ${Build.VERSION.SDK_INT})"
                )
                android.security.keystore2.AndroidKeyStoreProvider.install()
                Keystore2Interceptor
            }
        }
}
