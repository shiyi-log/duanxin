#include "boot_guard.h"

#include <stdint.h>

#include "esp_attr.h"

#define BOOT_GUARD_MAGIC 0x42475431u
#define BOOT_FAILURE_LIMIT 3u

typedef struct {
    uint32_t magic;
    uint32_t failed_starts;
    uint32_t pending_start;
} boot_guard_state_t;

static RTC_DATA_ATTR boot_guard_state_t s_boot_state;

bool boot_guard_begin(void)
{
    if (s_boot_state.magic != BOOT_GUARD_MAGIC) {
        s_boot_state.magic = BOOT_GUARD_MAGIC;
        s_boot_state.failed_starts = 0;
        s_boot_state.pending_start = 0;
    }
    if (s_boot_state.pending_start && s_boot_state.failed_starts < UINT32_MAX) {
        ++s_boot_state.failed_starts;
    }
    s_boot_state.pending_start = 1;
    return s_boot_state.failed_starts >= BOOT_FAILURE_LIMIT;
}

void boot_guard_mark_healthy(void)
{
    s_boot_state.magic = BOOT_GUARD_MAGIC;
    s_boot_state.pending_start = 0;
    s_boot_state.failed_starts = 0;
}

void boot_guard_clear(void)
{
    s_boot_state.magic = BOOT_GUARD_MAGIC;
    s_boot_state.pending_start = 0;
    s_boot_state.failed_starts = 0;
}
