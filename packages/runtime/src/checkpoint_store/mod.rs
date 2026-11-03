//! Checkpoint store v1 (PLAN-0653).
//!
//! The frozen on-disk contract lives in [`FORMAT.md`](FORMAT.md); implementation
//! modules must follow it. This module is introduced incrementally: M1/T1.1
//! starts with the blob codec and its atomic write path.

pub mod blob;
