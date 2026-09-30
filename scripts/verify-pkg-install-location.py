#!/usr/bin/env python3
"""Verify that a built Koala Clash PKG cannot relocate its app bundle."""

import argparse
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


def verify_package(package: Path) -> None:
    if not package.is_file():
        raise ValueError(f"PKG does not exist: {package}")

    with tempfile.TemporaryDirectory(prefix="koala-pkg-verify-") as temp_dir:
        expanded = Path(temp_dir) / "expanded"
        subprocess.run(["pkgutil", "--expand", str(package), str(expanded)], check=True)

        package_infos = list(expanded.rglob("PackageInfo"))
        if len(package_infos) != 1:
            raise ValueError(
                f"Expected one component PackageInfo in {package}, found {len(package_infos)}"
            )

        package_info = package_infos[0]
        root = ET.parse(package_info).getroot()
        if root.tag != "pkg-info" or root.get("identifier") != "com.koala-clash":
            raise ValueError(f"Unexpected component in {package_info}")
        if root.get("install-location") != "/Applications":
            raise ValueError(
                f"{package_info}: install-location must be /Applications, "
                f"got {root.get('install-location')!r}"
            )

        relocation = root.find("relocate")
        if relocation is not None and (
            len(relocation) > 0 or (relocation.text or "").strip()
        ):
            raise ValueError(f"{package_info}: bundle relocation is enabled")

    print(f"Verified fixed /Applications install location: {package}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path)
    args = parser.parse_args()

    try:
        for package in args.packages:
            verify_package(package)
    except (OSError, subprocess.CalledProcessError, ET.ParseError, ValueError) as error:
        print(f"PKG install-location verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
