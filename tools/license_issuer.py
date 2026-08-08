#!/usr/bin/env python3
"""Offline Ed25519 license issuer and verifier for TEESimulator-RS.

The private key is issuer-only material. The Android module only receives the
public key and verifies the signed claims against its local backup identity.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import re
import sys
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

PRODUCT = "TEESimulator-RS"
FORMAT = "TEERS-LICENSE-1"
FINGERPRINT_DOMAIN = b"TEESimulator-RS/v1\n"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
EXPECTED_EMMCID_LENGTH = 52
FIELDS = (
    "version",
    "license_id",
    "product",
    "fingerprint",
    "issued_at",
    "expires_at",
    "features",
)


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def fingerprint_for_emmcid(emmcid: str) -> str:
    normalized = emmcid.strip()
    if len(normalized) != EXPECTED_EMMCID_LENGTH or any(ord(c) < 0x20 for c in normalized):
        fail("emmcid must be the 52-byte printable backup candidate")
    return hashlib.sha256(FINGERPRINT_DOMAIN + normalized.encode("utf-8")).hexdigest()


def read_private_key(path: Path) -> Ed25519PrivateKey:
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except Exception as exc:  # pragma: no cover - backend-specific error text
        fail(f"could not read private key: {exc}")
    if not isinstance(key, Ed25519PrivateKey):
        fail("private key is not Ed25519")
    return key


def read_public_key(path: Path) -> Ed25519PublicKey:
    value = path.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        fail("public key file must contain exactly 32 bytes as 64 hex characters")
    return Ed25519PublicKey.from_public_bytes(bytes.fromhex(value))


def b64u_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64u_decode(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        fail("signature is not base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def canonical_payload(claims: dict[str, str]) -> bytes:
    if set(claims) != set(FIELDS):
        fail("license claims do not match the required schema")
    rows = [FORMAT]
    for field in FIELDS:
        value = claims[field]
        if "\n" in value or "\r" in value or "=" in value:
            fail(f"invalid character in {field}")
        rows.append(f"{field}={value}")
    return ("\n".join(rows) + "\n").encode("utf-8")


def parse_license(path: Path) -> tuple[dict[str, str], bytes, bytes]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        fail(f"could not read license: {exc}")
    if len(lines) != len(FIELDS) + 2 or lines[0] != FORMAT or not lines[-1].startswith("signature="):
        fail("license format is invalid")
    claims: dict[str, str] = {}
    for line in lines[1:-1]:
        key, separator, value = line.partition("=")
        if not separator or key in claims:
            fail("license contains duplicate or malformed claims")
        claims[key] = value
    payload = canonical_payload(claims)
    signature = b64u_decode(lines[-1][len("signature=") :])
    if len(signature) != 64:
        fail("Ed25519 signature must be 64 bytes")
    return claims, payload, signature


def validate_claims(claims: dict[str, str], now: int, emmcid: str | None) -> None:
    if claims["version"] != "1" or claims["product"] != PRODUCT:
        fail("license product or version is not supported")
    if not claims["license_id"] or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", claims["license_id"]):
        fail("license_id is invalid")
    if not HEX64.fullmatch(claims["fingerprint"]):
        fail("fingerprint is invalid")
    try:
        issued = int(claims["issued_at"])
        expires = int(claims["expires_at"])
    except ValueError:
        fail("license timestamps are invalid")
    if expires <= issued or now < issued - 300 or now > expires + 300:
        fail("license is outside its validity window")
    if not re.fullmatch(r"[a-z0-9]+(?:,[a-z0-9]+)*", claims["features"]):
        fail("license features are invalid")
    if emmcid is not None and claims["fingerprint"] != fingerprint_for_emmcid(emmcid):
        fail("license is bound to a different device")


def command_init(args: argparse.Namespace) -> None:
    private_path = Path(args.private_key)
    public_path = Path(args.public_key)
    if (private_path.exists() or public_path.exists()) and not args.force:
        fail("key file exists; pass --force to replace it")
    private_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)
    private = Ed25519PrivateKey.generate()
    private_path.write_bytes(
        private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    os.chmod(private_path, 0o600)
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    public_path.write_text(public.hex() + "\n", encoding="ascii")
    os.chmod(public_path, 0o644)
    print(f"private_key={private_path}")
    print(f"public_key={public_path}")
    print(f"public_key_hex={public.hex()}")


def command_issue(args: argparse.Namespace) -> None:
    private = read_private_key(Path(args.private_key))
    fingerprint = args.fingerprint or fingerprint_for_emmcid(args.emmcid)
    issued = int(args.issued_at if args.issued_at is not None else time.time())
    expires = int(args.expires_at) if args.expires_at is not None else issued + args.days * 86400
    features = ",".join(sorted(set(args.features.split(","))))
    if not HEX64.fullmatch(fingerprint):
        fail("fingerprint must be 32 bytes as 64 lowercase hex characters")
    if expires <= issued:
        fail("license expiry must be after issue time")
    if not re.fullmatch(r"[a-z0-9]+(?:,[a-z0-9]+)*", features):
        fail("features must be comma-separated lowercase names")
    claims = {
        "version": "1",
        "license_id": args.license_id or str(uuid.uuid4()),
        "product": PRODUCT,
        "fingerprint": fingerprint,
        "issued_at": str(issued),
        "expires_at": str(expires),
        "features": features,
    }
    payload = canonical_payload(claims)
    signature = b64u_encode(private.sign(payload))
    output = payload.decode("utf-8") + f"signature={signature}\n"
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(output.encode("utf-8"))
    os.chmod(target, 0o600)
    print(f"license={target}")
    print(f"license_id={claims['license_id']}")
    print(f"expires_at={expires}")


def command_verify(args: argparse.Namespace) -> None:
    public = read_public_key(Path(args.public_key))
    claims, payload, signature = parse_license(Path(args.license))
    try:
        public.verify(signature, payload)
    except Exception:
        fail("Ed25519 signature verification failed")
    validate_claims(claims, int(args.now if args.now is not None else time.time()), args.emmcid)
    print("verified")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="generate an issuer keypair")
    init.add_argument("--private-key", required=True)
    init.add_argument("--public-key", required=True)
    init.add_argument("--force", action="store_true")
    init.set_defaults(handler=command_init)

    issue = subparsers.add_parser("issue", help="sign an offline license")
    issue.add_argument("--private-key", required=True)
    identity = issue.add_mutually_exclusive_group(required=True)
    identity.add_argument("--emmcid")
    identity.add_argument("--fingerprint")
    issue.add_argument("--out", required=True)
    issue.add_argument("--license-id")
    issue.add_argument("--issued-at", type=int)
    issue.add_argument("--expires-at", type=int)
    issue.add_argument("--days", type=int, default=365)
    issue.add_argument("--features", default="donation,customization")
    issue.set_defaults(handler=command_issue)

    verify = subparsers.add_parser("verify", help="verify a license offline")
    verify.add_argument("--public-key", required=True)
    verify.add_argument("--license", required=True)
    verify.add_argument("--emmcid")
    verify.add_argument("--now", type=int)
    verify.set_defaults(handler=command_verify)
    return parser


if __name__ == "__main__":
    arguments = build_parser().parse_args()
    arguments.handler(arguments)
