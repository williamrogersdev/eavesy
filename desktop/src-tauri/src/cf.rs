#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void, CStr, CString};

pub type CFTypeRef = *const c_void;
const UTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> bool;
    pub fn CFArrayGetCount(array: CFTypeRef) -> isize;
    pub fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
    pub fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFNumberGetValue(number: CFTypeRef, kind: isize, value: *mut c_void) -> bool;
    pub static kCFBooleanTrue: CFTypeRef;
}

pub struct Owned(pub CFTypeRef);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

pub unsafe fn cf_str(s: &str) -> Owned {
    let c = CString::new(s).expect("no NULs in CF string literals");
    Owned(CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8))
}

pub unsafe fn cf_string(value: CFTypeRef) -> Option<String> {
    if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
        return None;
    }
    let mut buf = [0 as c_char; 256];
    CFStringGetCString(value, buf.as_mut_ptr(), buf.len() as isize, UTF8)
        .then(|| CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
}

pub unsafe fn cf_i32(value: CFTypeRef) -> Option<i32> {
    const SINT32: isize = 3;
    let mut out = 0i32;
    (!value.is_null() && CFNumberGetValue(value, SINT32, &mut out as *mut i32 as *mut c_void)).then_some(out)
}
