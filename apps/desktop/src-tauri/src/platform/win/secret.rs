//! DPAPI-backed secret storage for API keys.
//!
//! `CryptProtectData` with the default (per-user) scope ties the ciphertext to
//! the current Windows account, so a settings file copied to another machine —
//! or picked up by a backup / sync tool — does not carry usable credentials.
//! This is the same protection level the browser password stores use, and it
//! needs no user-visible key management.

use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Description recorded inside the blob; shows up in DPAPI audit tooling.
const DESCRIPTION: windows::core::PCWSTR = windows::core::w!("Lumen Translation API key");

/// Copy a DPAPI output blob into a `Vec` and release the LocalAlloc buffer.
///
/// # Safety
/// `blob` must be an output blob filled in by `CryptProtectData` /
/// `CryptUnprotectData`, whose `pbData` is owned by the caller.
unsafe fn take_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() {
        return Vec::new();
    }
    let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    let _ = unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut _))) };
    out
}

/// Encrypt `plain` for the current user. `None` means DPAPI refused, in which
/// case the caller stores the value unencrypted rather than losing it.
pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &input,
            DESCRIPTION,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .ok()?;
        Some(take_blob(&output))
    }
}

/// Decrypt a blob produced by [`protect`]. `None` means the blob belongs to a
/// different user or machine, or has been tampered with.
pub fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .ok()?;
        Some(take_blob(&output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_key() {
        let plain = b"sk-test-1234567890";
        let cipher = protect(plain).expect("DPAPI protect");
        assert_ne!(cipher.as_slice(), plain.as_slice());
        assert_eq!(unprotect(&cipher).as_deref(), Some(plain.as_slice()));
    }

    #[test]
    fn rejects_a_tampered_blob() {
        let mut cipher = protect(b"secret").expect("DPAPI protect");
        let last = cipher.len() - 1;
        cipher[last] ^= 0xff;
        assert!(unprotect(&cipher).is_none());
    }

    #[test]
    fn round_trips_an_empty_value() {
        let cipher = protect(b"").expect("DPAPI protect");
        assert_eq!(unprotect(&cipher), Some(Vec::new()));
    }
}
