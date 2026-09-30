#!/usr/bin/env python3
"""Verify a packaged macOS app's signature and launchable Electron binary."""

import argparse
import os
import platform
import plistlib
import re
import secrets
import subprocess
import sys
from pathlib import Path


LIBRARY_VALIDATION_ENTITLEMENT = "com.apple.security.cs.disable-library-validation"
HELPER_SUFFIXES = ("", " (GPU)", " (Plugin)", " (Renderer)")


def normalize_arch(value: str) -> str:
    arch = value.lower()
    if arch in {"x64", "x86_64", "amd64"}:
        return "x64"
    if arch in {"arm64", "aarch64"}:
        return "arm64"
    raise ValueError(f"unsupported architecture: {value}")


def read_bundle_info(bundle: Path) -> dict:
    with (bundle / "Contents/Info.plist").open("rb") as info_file:
        info = plistlib.load(info_file)
    if not isinstance(info, dict):
        raise ValueError(f"invalid Info.plist: {bundle}")
    return info


def signed_executables(app: Path) -> tuple[Path, list[Path]]:
    info = read_bundle_info(app)
    name = info.get("CFBundleExecutable")
    if not isinstance(name, str) or not name:
        raise ValueError("main app has no CFBundleExecutable")
    main = app / "Contents/MacOS" / name
    helpers = []
    for suffix in HELPER_SUFFIXES:
        helper_app = app / "Contents/Frameworks" / f"{name} Helper{suffix}.app"
        helper_info = read_bundle_info(helper_app)
        helper_name = helper_info.get("CFBundleExecutable")
        if not isinstance(helper_name, str) or not helper_name:
            raise ValueError(f"helper has no CFBundleExecutable: {helper_app}")
        helpers.append(helper_app / "Contents/MacOS" / helper_name)
    return main, helpers


def signature_metadata(executable: Path) -> tuple[bool, bool]:
    result = subprocess.run(
        ["/usr/bin/codesign", "-dv", "--verbose=4", str(executable)],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ValueError(f"invalid code signature: {executable}: {result.stderr.decode(errors='replace').strip()}")
    output = result.stderr.decode(errors="replace")
    team = re.search(r"(?m)^TeamIdentifier=(.+)$", output)
    flags = re.search(r"(?m)^CodeDirectory\b.*\bflags=0x[0-9a-fA-F]+\(([^)]*)\)", output)
    if not team or not flags:
        raise ValueError(f"could not read signing identity or flags: {executable}")
    no_team_id = team.group(1).strip() == "not set"
    hardened_runtime = "runtime" in {flag.strip() for flag in flags.group(1).split(",")}
    return no_team_id, hardened_runtime


def signed_entitlements(executable: Path) -> dict:
    result = subprocess.run(
        ["/usr/bin/codesign", "-d", "--entitlements", "-", "--xml", str(executable)],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ValueError(f"could not read signed entitlements: {executable}: {result.stderr.decode(errors='replace').strip()}")
    if not result.stdout:
        return {}
    try:
        entitlements = plistlib.loads(result.stdout)
    except (plistlib.InvalidFileException, ValueError, TypeError) as error:
        raise ValueError(f"invalid signed entitlements plist: {executable}") from error
    if not isinstance(entitlements, dict):
        raise ValueError(f"signed entitlements are not a plist dictionary: {executable}")
    return entitlements


def verify_static(app: Path) -> tuple[Path | None, str | None, list[str]]:
    problems = []
    try:
        info = read_bundle_info(app)
        version = info.get("CFBundleShortVersionString")
        if not isinstance(version, str) or not version:
            raise ValueError("main app has no CFBundleShortVersionString")
        main, helpers = signed_executables(app)
    except (OSError, ValueError) as error:
        return None, None, [str(error)]

    result = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        problems.append(f"deep strict signature verification failed: {result.stderr.decode(errors='replace').strip()}")

    for executable in [main, *helpers]:
        if not executable.is_file():
            problems.append(f"signed executable missing: {executable}")
            continue
        try:
            no_team_id, hardened_runtime = signature_metadata(executable)
            entitlements = signed_entitlements(executable)
        except ValueError as error:
            problems.append(str(error))
            continue
        if no_team_id and hardened_runtime and entitlements.get(LIBRARY_VALIDATION_ENTITLEMENT) is not True:
            problems.append(
                f"{executable}: no Team ID + Hardened Runtime requires "
                f"{LIBRARY_VALIDATION_ENTITLEMENT}=true"
            )
    return main, version, problems


def verify_runtime(executable: Path, timeout: float) -> str:
    marker = f"KOALA_LAUNCH_PROBE_{secrets.token_hex(12)}"
    script = f"process.stdout.write('{marker} electron=' + process.versions.electron + '\\n')"
    env = os.environ.copy()
    env.pop("NODE_OPTIONS", None)
    env.pop("VSCODE_INSPECTOR_OPTIONS", None)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        result = subprocess.run(
            [str(executable), "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"runtime probe timed out after {timeout:g}s") from error
    if result.returncode:
        detail = result.stderr.strip().splitlines()
        raise ValueError(
            f"runtime probe exited {result.returncode}: "
            + (" | ".join(detail[-3:]) if detail else "no stderr")
        )
    lines = result.stdout.splitlines()
    matches = [line for line in lines if line.startswith(f"{marker} electron=")]
    if len(matches) != 1:
        raise ValueError("runtime probe did not print its unique marker and Electron version")
    version = matches[0].partition("electron=")[2]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?", version):
        raise ValueError(f"runtime probe returned an invalid Electron version: {version!r}")
    return matches[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="path to the packaged Koala Clash.app")
    parser.add_argument("--target-arch", choices=("x64", "arm64"), required=True)
    parser.add_argument("--runner-arch", default=platform.machine())
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        runner_arch = normalize_arch(args.runner_arch)
    except ValueError as error:
        parser.error(str(error))

    main_executable, bundle_version, problems = verify_static(args.app)
    print(f"STATIC CHECKED: {'FAIL' if problems else 'PASS'} ({args.app})")
    if runner_arch == args.target_arch and main_executable is not None:
        try:
            marker_line = verify_runtime(main_executable, args.timeout)
            print(f"RUNTIME PASS: {marker_line} bundle={bundle_version}")
        except ValueError as error:
            problems.append(str(error))
            print("RUNTIME FAILED")
    elif runner_arch != args.target_arch:
        print(f"RUNTIME SKIPPED: target {args.target_arch}, runner {runner_arch}; static checked")
    else:
        print("RUNTIME SKIPPED: main executable unavailable")

    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
