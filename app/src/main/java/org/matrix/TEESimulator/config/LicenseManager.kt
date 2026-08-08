package org.matrix.TEESimulator.config

import java.io.File
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import org.bouncycastle.asn1.edec.EdECObjectIdentifiers
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.matrix.TEESimulator.logging.SystemLogger

/** Verifies an issuer-signed, device-bound offline license before interception starts. */
object LicenseManager {
    private const val LICENSE_FILE = "/data/adb/tricky_store/license.lic"
    private const val STATUS_FILE = "/data/adb/tricky_store/license_status"
    private const val FINGERPRINT_FILE = "/data/adb/tricky_store/license_device_fingerprint"
    private const val PUBLIC_KEY_FILE = "/data/adb/modules/tricky_store/license_public_key"
    private const val BACKUP_PARTITION = "/dev/block/by-name/backup"
    private const val FORMAT = "TEERS-LICENSE-1"
    private const val PRODUCT = "TEESimulator-RS"
    private const val FINGERPRINT_DOMAIN = "TEESimulator-RS/v1\n"
    private const val EMMCID_LENGTH = 52
    private const val MAX_BACKUP_BYTES = 16 * 1024 * 1024
    private val claimFields = listOf("version", "license_id", "product", "fingerprint", "issued_at", "expires_at", "features")

    private class LicenseFailure(val status: String, message: String) : Exception(message)

    fun verifyOrThrow() {
        try {
            val candidate = readEmmcIdCandidate()
            val expectedFingerprint = fingerprint(candidate)
            writeFingerprint(expectedFingerprint)
            val claims = readClaims()
            verifySignature(claims.payload, claims.signature)
            validateClaims(claims.values)
            if (claims.values["fingerprint"] != expectedFingerprint) {
                throw LicenseFailure("device_mismatch", "license is bound to another backup identity")
            }
            writeStatus("verified")
            SystemLogger.info("Offline license verified: ${claims.values["license_id"]}")
        } catch (failure: LicenseFailure) {
            if (failure.status == "unavailable") clearFingerprint()
            writeStatus(failure.status)
            SystemLogger.error("Offline license rejected: ${failure.message}")
            throw failure
        } catch (error: Exception) {
            clearFingerprint()
            writeStatus("unavailable")
            SystemLogger.error("Offline license validation failed", error)
            throw LicenseFailure("unavailable", error.message ?: "license validation failed")
        }
    }

    private data class ParsedLicense(
        val values: Map<String, String>,
        val payload: ByteArray,
        val signature: ByteArray,
    )

    private fun readClaims(): ParsedLicense {
        val file = File(LICENSE_FILE)
        if (!file.isFile) throw LicenseFailure("missing", "license file is missing")
        val lines = file.readText(Charsets.UTF_8).replace("\r\n", "\n").split('\n').dropLastWhile { it.isEmpty() }
        if (lines.size != claimFields.size + 2 || lines.firstOrNull() != FORMAT) {
            throw LicenseFailure("invalid_format", "license header or field count is invalid")
        }
        val values = linkedMapOf<String, String>()
        for (line in lines.drop(1).dropLast(1)) {
            val separator = line.indexOf('=')
            if (separator <= 0) throw LicenseFailure("invalid_format", "malformed license claim")
            val key = line.substring(0, separator)
            val value = line.substring(separator + 1)
            if (key in values) throw LicenseFailure("invalid_format", "duplicate license claim")
            values[key] = value
        }
        if (values.keys != claimFields.toSet()) {
            throw LicenseFailure("invalid_format", "license claims do not match the schema")
        }
        val signatureValue = lines.last().removePrefix("signature=")
        val signature = try {
            Base64.getUrlDecoder().decode(signatureValue)
        } catch (error: IllegalArgumentException) {
            throw LicenseFailure("invalid_signature", "signature is not base64url")
        }
        if (signature.size != 64) throw LicenseFailure("invalid_signature", "Ed25519 signature size is invalid")
        return ParsedLicense(values, canonicalPayload(values), signature)
    }

    private fun canonicalPayload(values: Map<String, String>): ByteArray {
        val payload = buildString {
            append(FORMAT).append('\n')
            for (field in claimFields) {
                val value = values[field] ?: throw LicenseFailure("invalid_format", "missing claim: $field")
                if (value.any { it == '\r' || it == '\n' || it == '=' }) {
                    throw LicenseFailure("invalid_format", "invalid character in claim: $field")
                }
                append(field).append('=').append(value).append('\n')
            }
        }
        return payload.toByteArray(Charsets.UTF_8)
    }

    private fun verifySignature(payload: ByteArray, signature: ByteArray) {
        val verifier = Signature.getInstance("Ed25519", "BC")
        verifier.initVerify(readPublicKey())
        verifier.update(payload)
        if (!verifier.verify(signature)) throw LicenseFailure("invalid_signature", "Ed25519 signature mismatch")
    }

    private fun readPublicKey(): PublicKey {
        val hex = File(PUBLIC_KEY_FILE).readText(Charsets.US_ASCII).trim()
        if (!hex.matches(Regex("[0-9a-fA-F]{64}"))) {
            throw LicenseFailure("invalid_key", "module public key is invalid")
        }
        val raw = hexToBytes(hex)
        val info = SubjectPublicKeyInfo(AlgorithmIdentifier(EdECObjectIdentifiers.id_Ed25519), raw)
        return KeyFactory.getInstance("Ed25519", "BC").generatePublic(X509EncodedKeySpec(info.encoded))
    }

    private fun validateClaims(values: Map<String, String>) {
        if (values["version"] != "1" || values["product"] != PRODUCT) {
            throw LicenseFailure("invalid_product", "license product or version is unsupported")
        }
        if (!values.getValue("license_id").matches(Regex("[A-Za-z0-9._:-]{1,128}"))) {
            throw LicenseFailure("invalid_format", "license id is invalid")
        }
        if (!values.getValue("fingerprint").matches(Regex("[0-9a-f]{64}"))) {
            throw LicenseFailure("invalid_format", "license fingerprint is invalid")
        }
        val issued = values.getValue("issued_at").toLongOrNull()
            ?: throw LicenseFailure("invalid_format", "issued_at is invalid")
        val expires = values.getValue("expires_at").toLongOrNull()
            ?: throw LicenseFailure("invalid_format", "expires_at is invalid")
        val now = System.currentTimeMillis() / 1000
        if (expires <= issued || now < issued - 300 || now > expires + 300) {
            throw LicenseFailure("expired", "license is outside its validity window")
        }
        if (!values.getValue("features").matches(Regex("[a-z0-9]+(?:,[a-z0-9]+)*"))) {
            throw LicenseFailure("invalid_format", "license features are invalid")
        }
    }

    private fun readEmmcIdCandidate(): String {
        val partition = File(BACKUP_PARTITION)
        if (!partition.canRead()) throw LicenseFailure("unavailable", "backup partition is not readable")
        val bytes = partition.inputStream().use { it.readNBytes(MAX_BACKUP_BYTES) }
        val marker = byteArrayOf('0'.code.toByte(), '1'.code.toByte(), 'c'.code.toByte(), 'e'.code.toByte())
        for (offset in 0..bytes.size - marker.size) {
            if (!bytes.copyOfRange(offset, offset + marker.size).contentEquals(marker)) continue
            if (offset + EMMCID_LENGTH > bytes.size) continue
            val candidate = bytes.copyOfRange(offset, offset + EMMCID_LENGTH).toString(Charsets.US_ASCII)
            if (candidate.all { it in ' '..'~' }) return candidate
        }
        throw LicenseFailure("unavailable", "01ce ASCII identity was not found in backup")
    }

    private fun fingerprint(candidate: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest((FINGERPRINT_DOMAIN + candidate).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun hexToBytes(value: String): ByteArray = ByteArray(value.length / 2) { index ->
        value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }

    private fun writeStatus(status: String) {
        writeStateFile(STATUS_FILE, status)
    }

    private fun writeFingerprint(value: String) {
        writeStateFile(FINGERPRINT_FILE, value)
    }

    private fun clearFingerprint() {
        runCatching { File(FINGERPRINT_FILE).delete() }
    }

    private fun writeStateFile(path: String, value: String) {
        runCatching {
            val target = File(path)
            target.parentFile?.mkdirs()
            val temporary = File("$path.tmp")
            temporary.writeText("$value\n", Charsets.US_ASCII)
            if (!temporary.renameTo(target)) {
                target.delete()
                temporary.renameTo(target)
            }
        }
    }
}
