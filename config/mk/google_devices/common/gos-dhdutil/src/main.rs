use rustutils::system_properties;
use std::io;
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::ExitCode;

// Source paths in these comments are relative to the kernel_pixel root. bcm4390
// is used as the representative source tree for the shared Broadcom DHD ioctl ABI.
// dhd_ioctl_t, DHD_IOCTL_MAGIC and DHD_SET_VAR are from:
// private/google-modules/wlan/bcm4390/include/dhdioctl.h
const DHD_IOCTL_MAGIC: u32 = 0x00444944;
const DHD_SET_VAR: u32 = 3;

#[repr(C)]
struct DhdIoctl {
    cmd: u32,
    buf: *mut libc::c_void,
    len: u32,
    set: u32,
    used: u32,
    needed: u32,
    driver: u32,
}

// DHD_INDUCE_ERROR_CLEAR and DHD_INDUCE_SCAN_TIMEOUT are from:
// private/google-modules/wlan/bcm4390/dhd.h
// The "induce_error" iovar is registered and assigned in:
// private/google-modules/wlan/bcm4390/dhd_common.c
const DHD_INDUCE_ERROR_CLEAR: u32 = 0;
const DHD_INDUCE_SCAN_TIMEOUT: u32 = 8;
const DHD_INDUCE_ERROR_IOVAR: &[u8] = b"induce_error\0";
const DHD_INDUCE_ERROR_IOVAR_BUF_LEN: usize = DHD_INDUCE_ERROR_IOVAR.len() + mem::size_of::<u32>();
type IovarBuf = [u8; DHD_INDUCE_ERROR_IOVAR_BUF_LEN];

const RESULT_PROPERTY: &str = "vendor.gos.dhdutil.result";
const RESULT_PROPERTY_FORMAT: &str = "STATUS:TOKEN:DETAIL";
const REQUEST_FORMAT: &str = "wifi-scan-timeout:enable:TOKEN|wifi-scan-timeout:disable:TOKEN";
const WIFI_SCAN_TIMEOUT_REQUEST_PREFIX: &str = "wifi-scan-timeout:";
const WIFI_IFACE: &str = "wlan0";
const DEFAULT_TOKEN: &str = "none";
// Android's libc ioctl binding takes a c_int request, but libc::SIOCDEVPRIVATE is c_ulong.
const SIOCDEVPRIVATE: libc::c_int = libc::SIOCDEVPRIVATE as libc::c_int;

// This mirrors bcm_mkiovar() in private/google-modules/wlan/bcm4390/bcmutils.c:
// strlen(name) + 1 bytes for the NUL terminated iovar name, then the value bytes
// appended immediately after it. Keep this as a byte buffer because a Rust or C
// struct would insert padding before the u32 after the 13 byte name.
fn make_iovar_buf(value: u32) -> IovarBuf {
    let mut buf = [0; DHD_INDUCE_ERROR_IOVAR_BUF_LEN];
    let (name, data) = buf.split_at_mut(DHD_INDUCE_ERROR_IOVAR.len());
    name.copy_from_slice(DHD_INDUCE_ERROR_IOVAR);
    data.copy_from_slice(&value.to_ne_bytes());
    buf
}

fn wifi_ifreq_name() -> [libc::c_char; libc::IFNAMSIZ] {
    const {
        assert!(WIFI_IFACE.len() < libc::IFNAMSIZ, "WIFI_IFACE is too long");
    }

    let mut name = [0; libc::IFNAMSIZ];
    for (dst, src) in name.iter_mut().zip(WIFI_IFACE.bytes()) {
        *dst = src as libc::c_char;
    }
    name
}

#[derive(Clone, Copy)]
enum WifiScanTimeoutAction {
    Enable,
    Disable,
}

impl WifiScanTimeoutAction {
    fn parse(request: &str) -> Option<(Self, &str)> {
        let request = request.strip_prefix(WIFI_SCAN_TIMEOUT_REQUEST_PREFIX)?;
        let (command, token) = if let Some(token) = request.strip_prefix("enable:") {
            (Self::Enable, token)
        } else if let Some(token) = request.strip_prefix("disable:") {
            (Self::Disable, token)
        } else {
            return None;
        };

        Some((
            command,
            if token.is_empty() {
                DEFAULT_TOKEN
            } else {
                token
            },
        ))
    }

    fn dhd_value(self) -> u32 {
        match self {
            Self::Enable => DHD_INDUCE_SCAN_TIMEOUT,
            Self::Disable => DHD_INDUCE_ERROR_CLEAR,
        }
    }

    fn names(self) -> (&'static str, &'static str) {
        match self {
            Self::Enable => ("enable", "enabled"),
            Self::Disable => ("disable", "disabled"),
        }
    }
}

fn set_result(token: &str, status: &str, detail: &str) -> bool {
    system_properties::write(RESULT_PROPERTY, &format!("{status}:{token}:{detail}")).is_ok()
}

fn set_dhd_induce_error(value: u32) -> io::Result<()> {
    let mut iovar = make_iovar_buf(value);

    let mut ioc = DhdIoctl {
        cmd: DHD_SET_VAR,
        buf: iovar.as_mut_ptr().cast(),
        len: iovar.len() as u32,
        set: 1,
        used: 0,
        needed: 0,
        driver: DHD_IOCTL_MAGIC,
    };

    let mut ifr = libc::ifreq {
        // ifreq.ifr_name is a fixed-size NUL-terminated C string.
        ifr_name: wifi_ifreq_name(),
        ifr_ifru: libc::__c_anonymous_ifr_ifru {
            ifru_data: (&mut ioc as *mut DhdIoctl).cast::<libc::c_char>(),
        },
    };

    // SAFETY: socket is called with constant domain/type/protocol values. On success, the raw fd is
    // immediately wrapped in OwnedFd so it is closed on every return path.
    let raw_fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw_fd was just returned by socket and is not owned anywhere else.
    let sock = unsafe { OwnedFd::from_raw_fd(raw_fd) };

    // SAFETY: ifr is an initialized ifreq for the bcmdhd SIOCDEVPRIVATE path.
    // ifr.ifr_ifru.ifru_data points to ioc, and ioc.buf points to iovar; both
    // locals remain alive and mutable until ioctl returns.
    let ret = unsafe { libc::ioctl(sock.as_raw_fd(), SIOCDEVPRIVATE, &mut ifr) };
    if ret < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args();
    let program = args.next().unwrap_or_else(|| "gos-dhdutil".to_string());
    let request = match (args.next(), args.next()) {
        (Some(request), None) => request,
        _ => {
            set_result(DEFAULT_TOKEN, "error", "usage");
            eprintln!("usage: {program} {REQUEST_FORMAT}");
            eprintln!("TOKEN is echoed in {RESULT_PROPERTY} as {RESULT_PROPERTY_FORMAT}");
            return ExitCode::from(2);
        }
    };

    let Some((command, token)) = WifiScanTimeoutAction::parse(&request) else {
        set_result(DEFAULT_TOKEN, "error", "bad-request");
        eprintln!("invalid request: {request}");
        return ExitCode::from(2);
    };

    let (request_name, state) = command.names();
    if let Err(err) = set_dhd_induce_error(command.dhd_value()) {
        let errno = err.raw_os_error().unwrap_or(libc::EIO);
        set_result(token, "error", &format!("errno={errno}"));
        eprintln!(
            "failed to {} wl_scan_timeout induction on {WIFI_IFACE}: errno={errno}",
            request_name
        );
        return ExitCode::FAILURE;
    }

    if !set_result(token, "ok", state) {
        eprintln!("failed to set result property after {state} wl_scan_timeout induction");
        return ExitCode::FAILURE;
    }

    println!("ok:{token}:{state}");
    ExitCode::SUCCESS
}
