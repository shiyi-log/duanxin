#pragma once

#include <stdbool.h>

bool boot_guard_begin(void);
void boot_guard_mark_healthy(void);
void boot_guard_clear(void);
