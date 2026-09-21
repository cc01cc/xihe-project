//! Non-Windows stub for the job engine syscall boundary.
//!
//! The engine only owns Windows process trees; every other platform reports
//! `UNSUPPORTED_PLATFORM` instead of pretending to work.
#![allow(dead_code)]

use std::ffi::c_void;

pub type RawHandle = *mut c_void;

pub const WAIT_OBJECT_0: u32 = 0;
pub const WAIT_TIMEOUT: u32 = 258;
pub const WAIT_FAILED: u32 = u32::MAX;
pub const ERROR_NOT_FOUND: u32 = 1168;
pub const CREATE_SUSPENDED_FLAG: u32 = 0;
pub const UNSUPPORTED_PLATFORM: u32 = 1;

pub struct JobObject;

impl JobObject {
    pub fn create_kill_on_close() -> Result<Self, u32> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn assign(&self, _process: RawHandle) -> Result<(), u32> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn terminate(&self, _exit_code: u32) -> Result<(), u32> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn pids(&self) -> Result<Vec<u32>, u32> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn active_processes(&self) -> Result<u32, u32> {
        Err(UNSUPPORTED_PLATFORM)
    }
}

pub fn resume_main_thread(_pid: u32) -> Result<(), u32> {
    Err(UNSUPPORTED_PLATFORM)
}

pub fn wait_for_exit(_process: isize, _timeout_ms: Option<u64>) -> u32 {
    WAIT_FAILED
}
