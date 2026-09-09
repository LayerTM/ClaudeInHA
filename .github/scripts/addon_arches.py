#!/usr/bin/env python3
"""The architectures this add-on declares, read from the add-on's own files.

CI derives its build matrix from here rather than listing architectures in a
workflow, so adding one to the add-on cannot silently leave it unbuilt — the
failure mode this exists to prevent is a new arch that no job ever compiles.

It also refuses to answer when the two files disagree. `config.yaml: arch` is
what the Supervisor offers an installation; `build.yaml: build_from` is the base
image each of those is built from. Nothing enforced that they name the same set,
so an arch present in one and absent from the other was possible and invisible:
one way round the Supervisor offers an install that cannot be built, the other
way round we build something nobody is offered.

Usage:
  addon_arches.py                     -> compact JSON array, for a matrix
  addon_arches.py --build-from <arch> -> the base image for that architecture
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import yaml

ADDON = pathlib.Path(__file__).resolve().parents[2] / "claude-code"


def _load(name: str) -> dict:
    path = ADDON / name
    try:
        with path.open(encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except FileNotFoundError:
        sys.exit(f"{path} is missing")
    if not isinstance(data, dict):
        sys.exit(f"{path} does not contain a mapping")
    return data


def build_from() -> dict[str, str]:
    data = _load("build.yaml").get("build_from")
    if not isinstance(data, dict) or not data:
        sys.exit("build.yaml has no build_from mapping")
    return {str(k): str(v) for k, v in data.items()}


def declared() -> list[str]:
    """The architecture set both files agree on, sorted."""
    config = _load("config.yaml").get("arch")
    if not isinstance(config, list) or not config:
        sys.exit("config.yaml has no arch list")
    from_config = sorted(str(a) for a in config)
    from_build = sorted(build_from())
    if from_config != from_build:
        sys.exit(
            "claude-code/config.yaml and claude-code/build.yaml disagree about "
            f"architectures: config.yaml has {from_config}, build.yaml has "
            f"{from_build}. Every architecture offered must have a base image, "
            "and every base image must be for an architecture that is offered."
        )
    return from_config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--build-from",
        metavar="ARCH",
        help="print the base image for ARCH instead of the architecture list",
    )
    args = parser.parse_args()

    arches = declared()
    if args.build_from:
        image = build_from().get(args.build_from)
        if not image:
            sys.exit(f"No base image declared for '{args.build_from}'; have {arches}")
        print(image)
        return
    print(json.dumps(arches, separators=(",", ":")))


if __name__ == "__main__":
    main()
