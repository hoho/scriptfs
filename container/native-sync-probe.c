#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static bool enabled;

__attribute__((constructor)) static void initialize(void) {
    char executable[4096];
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length < 0) return;
    executable[length] = '\0';
    const char *name = strrchr(executable, '/');
    enabled = name && strcmp(name + 1, "scriptfs") == 0
        && access("/scriptfs/config.json", F_OK) == 0;
}

static int sync_descriptor(int fd, bool data) {
    char descriptor[64], path[4096];
    struct stat metadata;
    if (!enabled) return (int)syscall(data ? SYS_fdatasync : SYS_fsync, fd);
    snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(descriptor, path, sizeof(path) - 1);
    if (length < 0 || fstat(fd, &metadata) < 0) return -1;
    path[length] = '\0';
    const char *name = strrchr(path, '/');
    if (name && strcmp(name + 1, "sync-fail") == 0) {
        errno = EIO;
        return -1;
    }
    int result = (int)syscall(data ? SYS_fdatasync : SYS_fsync, fd);
    if (result < 0) return result;
    char escaped[sizeof(path) * 6], *cursor = escaped;
    for (const unsigned char *p = (const unsigned char *)path; *p; ++p) {
        if (*p == '\\' || *p == '"') {
            *cursor++ = '\\';
            *cursor++ = (char)*p;
        } else if (*p < 32) {
            cursor += sprintf(cursor, "\\u%04x", *p);
        } else {
            *cursor++ = (char)*p;
        }
    }
    *cursor = '\0';
    char event[sizeof(escaped) + 128];
    int size = snprintf(event, sizeof(event),
        "{\"kind\":\"%s\",\"path\":\"%s\",\"directory\":%s}\n",
        data ? "datasync" : "sync", escaped, S_ISDIR(metadata.st_mode) ? "true" : "false");
    int log = open("/scriptfs/sources/0/sync-events", O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (log < 0) return -1;
    ssize_t written = write(log, event, (size_t)size);
    int error = errno;
    int closed = close(log);
    if (written != size) {
        errno = written < 0 ? error : EIO;
        return -1;
    }
    return closed;
}

int fsync(int fd) { return sync_descriptor(fd, false); }
int fdatasync(int fd) { return sync_descriptor(fd, true); }
