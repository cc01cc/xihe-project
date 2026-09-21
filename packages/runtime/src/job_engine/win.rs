//! Windows syscall boundary of the process job engine (PLAN-0393).
//!
//! This is the single `unsafe` boundary of the engine (design decision #21):
//! Job Object lifecycle, suspended-spawn resume and process wait. Everything
//! above this file stays safe code, and no other module may declare `unsafe`.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::os::windows::io::RawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, INFINITE, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    WaitForSingleObject,
};

pub const WAIT_OBJECT_0: u32 = 0;
pub const WAIT_TIMEOUT: u32 = 258;
pub const WAIT_FAILED: u32 = u32::MAX;
pub const ERROR_NOT_FOUND: u32 = 1168;
const MAX_TRACKED_PIDS: usize = 512;

/// `true` when the process must not run until [`resume_main_thread`] is called.
pub const CREATE_SUSPENDED_FLAG: u32 = CREATE_SUSPENDED;

#[repr(C)]
struct PidListBuffer {
    number_of_assigned_processes: u32,
    number_of_process_ids_in_list: u32,
    process_id_list: [usize; MAX_TRACKED_PIDS],
}

/// Owned Windows Job Object handle.
///
/// The handle is a kernel object and may be shared across the engine threads;
/// it is closed exactly once, in [`Drop`], which also triggers
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for whatever is still inside.
pub struct JobObject {
    handle: HANDLE,
}

// SAFETY: a job object handle is a process-wide kernel handle; sharing it
// across threads is sound as long as it is not closed twice, which the owned
// wrapper guarantees.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// Creates a job object that kills every assigned process when the last
    /// handle to the job closes (Runtime exit / crash path, decision #19).
    pub fn create_kill_on_close() -> Result<Self, u32> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let error = last_error();
            let _ = unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self { handle })
    }

    /// Assigns an already-created (and still suspended) process to the job.
    pub fn assign(&self, process: RawHandle) -> Result<(), u32> {
        let ok = unsafe { AssignProcessToJobObject(self.handle, process as HANDLE) };
        if ok == 0 { Err(last_error()) } else { Ok(()) }
    }

    /// Terminates every process in the job.
    pub fn terminate(&self, exit_code: u32) -> Result<(), u32> {
        let ok = unsafe { TerminateJobObject(self.handle, exit_code) };
        if ok == 0 { Err(last_error()) } else { Ok(()) }
    }

    /// PIDs still assigned to the job (truncated to the tracked maximum).
    pub fn pids(&self) -> Result<Vec<u32>, u32> {
        let mut buffer = PidListBuffer {
            number_of_assigned_processes: 0,
            number_of_process_ids_in_list: 0,
            process_id_list: [0; MAX_TRACKED_PIDS],
        };
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicProcessIdList,
                &mut buffer as *mut _ as *mut c_void,
                std::mem::size_of::<PidListBuffer>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        let count = buffer
            .number_of_process_ids_in_list
            .min(MAX_TRACKED_PIDS as u32) as usize;
        Ok(buffer.process_id_list[..count]
            .iter()
            .map(|value| *value as u32)
            .collect())
    }

    /// Number of processes that are still active in the job.
    pub fn active_processes(&self) -> Result<u32, u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(last_error())
        } else {
            Ok(info.ActiveProcesses)
        }
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            let _ = unsafe { CloseHandle(self.handle) };
        }
    }
}

/// Resumes the primary thread of a process created with `CREATE_SUSPENDED`.
pub fn resume_main_thread(pid: u32) -> Result<(), u32> {
    let thread_id = find_thread_id(pid)?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() || thread == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    let previous = unsafe { ResumeThread(thread) };
    let _ = unsafe { CloseHandle(thread) };
    if previous == WAIT_FAILED {
        return Err(last_error());
    }
    Ok(())
}

/// Waits for the process to exit; `timeout_ms = None` waits without a deadline.
/// The handle is passed as `isize` so callers can move it across threads.
pub fn wait_for_exit(process: isize, timeout_ms: Option<u64>) -> u32 {
    let millis = match timeout_ms {
        None => INFINITE,
        Some(0) => INFINITE,
        Some(value) => value.min(u64::from(u32::MAX - 1)) as u32,
    };
    unsafe { WaitForSingleObject(process as HANDLE, millis) }
}

fn find_thread_id(pid: u32) -> Result<u32, u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = None;
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid {
            found = Some(entry.th32ThreadID);
            break;
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found.ok_or(ERROR_NOT_FOUND)
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}
