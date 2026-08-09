#include <unistd.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <signal.h>
#include <stdint.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <string>

#include "integrity_anchor.h"

static volatile sig_atomic_t should_exit = 0;
static const int LICENSE_REJECT_EXIT_CODE = 78;
static const int TAMPER_REJECT_EXIT_CODE = 79;

static void signal_handler(int sig) {
    (void)sig;
    should_exit = 1;
}

struct Sha256Context {
    uint8_t data[64];
    uint32_t state[8];
    uint64_t bit_length;
    size_t data_length;
};

static const uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static uint32_t rotr(uint32_t value, uint32_t count) {
    return (value >> count) | (value << (32U - count));
}

static uint32_t choose(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (~x & z);
}

static uint32_t majority(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (x & z) ^ (y & z);
}

static void sha256_transform(Sha256Context* context, const uint8_t* data) {
    uint32_t words[64];
    for (size_t i = 0; i < 16; ++i) {
        const size_t offset = i * 4;
        words[i] = (static_cast<uint32_t>(data[offset]) << 24) |
                   (static_cast<uint32_t>(data[offset + 1]) << 16) |
                   (static_cast<uint32_t>(data[offset + 2]) << 8) |
                   static_cast<uint32_t>(data[offset + 3]);
    }
    for (size_t i = 16; i < 64; ++i) {
        const uint32_t s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >> 3);
        const uint32_t s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >> 10);
        words[i] = words[i - 16] + s0 + words[i - 7] + s1;
    }

    uint32_t a = context->state[0];
    uint32_t b = context->state[1];
    uint32_t c = context->state[2];
    uint32_t d = context->state[3];
    uint32_t e = context->state[4];
    uint32_t f = context->state[5];
    uint32_t g = context->state[6];
    uint32_t h = context->state[7];

    for (size_t i = 0; i < 64; ++i) {
        const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const uint32_t temp1 = h + s1 + choose(e, f, g) + SHA256_K[i] + words[i];
        const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const uint32_t temp2 = s0 + majority(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    context->state[0] += a;
    context->state[1] += b;
    context->state[2] += c;
    context->state[3] += d;
    context->state[4] += e;
    context->state[5] += f;
    context->state[6] += g;
    context->state[7] += h;
}

static void sha256_init(Sha256Context* context) {
    context->data_length = 0;
    context->bit_length = 0;
    context->state[0] = 0x6a09e667;
    context->state[1] = 0xbb67ae85;
    context->state[2] = 0x3c6ef372;
    context->state[3] = 0xa54ff53a;
    context->state[4] = 0x510e527f;
    context->state[5] = 0x9b05688c;
    context->state[6] = 0x1f83d9ab;
    context->state[7] = 0x5be0cd19;
}

static void sha256_update(Sha256Context* context, const uint8_t* data, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        context->data[context->data_length++] = data[i];
        if (context->data_length == 64) {
            sha256_transform(context, context->data);
            context->bit_length += 512;
            context->data_length = 0;
        }
    }
}

static void sha256_final(Sha256Context* context, uint8_t hash[32]) {
    size_t index = context->data_length;
    context->data[index++] = 0x80;
    if (index > 56) {
        while (index < 64) context->data[index++] = 0;
        sha256_transform(context, context->data);
        index = 0;
    }
    while (index < 56) context->data[index++] = 0;
    context->bit_length += static_cast<uint64_t>(context->data_length) * 8;
    for (size_t i = 0; i < 8; ++i) {
        context->data[63 - i] = static_cast<uint8_t>(context->bit_length >> (i * 8));
    }
    sha256_transform(context, context->data);
    for (size_t i = 0; i < 8; ++i) {
        hash[i * 4] = static_cast<uint8_t>(context->state[i] >> 24);
        hash[i * 4 + 1] = static_cast<uint8_t>(context->state[i] >> 16);
        hash[i * 4 + 2] = static_cast<uint8_t>(context->state[i] >> 8);
        hash[i * 4 + 3] = static_cast<uint8_t>(context->state[i]);
    }
}

static bool sha256_file(const std::string& path, char output[65]) {
    FILE* file = fopen(path.c_str(), "rb");
    if (file == nullptr) return false;
    Sha256Context context;
    sha256_init(&context);
    uint8_t buffer[8192];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        sha256_update(&context, buffer, count);
    }
    const bool read_ok = feof(file) != 0;
    fclose(file);
    if (!read_ok) return false;
    uint8_t hash[32];
    sha256_final(&context, hash);
    for (size_t i = 0; i < 32; ++i) snprintf(output + i * 2, 3, "%02x", hash[i]);
    output[64] = '\0';
    return true;
}

struct IntegrityEntry {
    const char* path;
    const char* expected;
};

static int verify_install(const char* root) {
    const IntegrityEntry entries[] = {
        {"module.prop", EXPECTED_MODULE_PROP_SHA256},
        {"service.sh", EXPECTED_SERVICE_SHA256},
        {"customize.sh", EXPECTED_CUSTOMIZE_SHA256},
        {"daemon", EXPECTED_DAEMON_SHA256},
        {"verify_integrity.sh", EXPECTED_VERIFY_INTEGRITY_SHA256},
        {"webroot/index.html", EXPECTED_WEBROOT_INDEX_SHA256},
        {"webroot/app.css", EXPECTED_WEBROOT_CSS_SHA256},
        {"webroot/app.js", EXPECTED_WEBROOT_APP_SHA256},
        {"webroot/kernelsu.js", EXPECTED_WEBROOT_KERNELSU_SHA256},
    };
    for (const IntegrityEntry& entry : entries) {
        const std::string path = std::string(root) + "/" + entry.path;
        char actual[65];
        if (!sha256_file(path, actual) || strcmp(actual, entry.expected) != 0) return 2;
    }
    return 0;
}

static bool has_preload() {
    extern char** environ;
    for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
        if (strncmp(*entry, "LD_PRELOAD=", 11) == 0 && (*entry)[11] != '\0') return true;
    }
    return false;
}

static bool is_traced() {
    FILE* file = fopen("/proc/self/status", "r");
    if (file == nullptr) return false;
    char line[256];
    while (fgets(line, sizeof(line), file) != nullptr) {
        if (strncmp(line, "TracerPid:", 10) == 0) {
            const unsigned long tracer = strtoul(line + 10, nullptr, 10);
            fclose(file);
            return tracer != 0;
        }
    }
    fclose(file);
    return false;
}

static int runtime_guard() {
    if (has_preload() || is_traced()) return TAMPER_REJECT_EXIT_CODE;
    if (prctl(PR_SET_DUMPABLE, 0) != 0) return TAMPER_REJECT_EXIT_CODE;
    return 0;
}

static int runtime_check(const char* root) {
    const int integrity_status = verify_install(root);
    if (integrity_status != 0) return integrity_status;
    return runtime_guard();
}

static int stop_child(pid_t pid, int* status) {
    kill(pid, SIGKILL);
    waitpid(pid, status, 0);
    return TAMPER_REJECT_EXIT_CODE;
}

static int monitor_child(pid_t pid, int* status, const char* root) {
    while (!should_exit) {
        const pid_t result = waitpid(pid, status, WNOHANG);
        if (result == pid) return 0;
        if (result < 0 && errno != EINTR) return 0;
        if (runtime_check(root) != 0) return stop_child(pid, status);
        sleep(5);
    }
    kill(pid, SIGTERM);
    waitpid(pid, status, 0);
    return 0;
}

int main(int argc, char* argv[]) {
    if (argc == 3 && strcmp(argv[1], "--verify-install") == 0) {
        return verify_install(argv[2]);
    }
    if (argc == 3 && strcmp(argv[1], "--runtime-check") == 0) {
        return runtime_check(argv[2]);
    }
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <daemon> <module_root> [args...]\n", argv[0]);
        return 1;
    }

    const char* module_root = argv[2];
    if (runtime_check(module_root) != 0) return TAMPER_REJECT_EXIT_CODE;

    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);

    const char* daemon_path = argv[1];
    char** daemon_argv = &argv[1];
    int backoff_ms = 500;

    while (!should_exit) {
        struct timespec child_start;
        clock_gettime(CLOCK_MONOTONIC, &child_start);
        pid_t pid = fork();
        if (pid < 0) {
            usleep(100000);
            continue;
        }
        if (pid == 0) {
            prctl(PR_SET_PDEATHSIG, SIGKILL);
            setpriority(PRIO_PROCESS, 0, 10);
            execv(daemon_path, daemon_argv);
            _exit(127);
        }

        int status;
        if (monitor_child(pid, &status, module_root) == TAMPER_REJECT_EXIT_CODE) return 0;
        if (should_exit) break;
        if (WIFEXITED(status) && WEXITSTATUS(status) == LICENSE_REJECT_EXIT_CODE) return 0;
        if (WIFEXITED(status) && WEXITSTATUS(status) == TAMPER_REJECT_EXIT_CODE) return 0;

        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long lived_ms = (now.tv_sec - child_start.tv_sec) * 1000 +
                        (now.tv_nsec - child_start.tv_nsec) / 1000000;
        if (lived_ms > 30000) {
            backoff_ms = 500;
        } else {
            usleep(backoff_ms * 1000);
            if (backoff_ms < 30000) backoff_ms *= 2;
        }
    }
    return 0;
}
