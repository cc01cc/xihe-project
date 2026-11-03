//! Checkpoint store v1 (PLAN-0653).
//!
//! The frozen on-disk contract lives in [`FORMAT.md`](FORMAT.md); implementation
//! modules must follow it. This module is introduced incrementally: M1 starts
//! with the blob codec/atomic write path and the manifest codec.

pub mod blob;
pub mod manifest;
pub mod store;
