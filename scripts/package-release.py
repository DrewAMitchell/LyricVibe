"""Package only reviewed extension assets; no source checkout or browser data."""
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile


def package(source, output, commit):
    source, output = Path(source), Path(output)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected exact source commit")
    if output.exists():
        raise ValueError("Output already exists; published candidate bytes are never overwritten")
    build = source / "dist/lyricvibe"
    allowed = set(json.loads((source / "release-files.json").read_text()))
    paths = {}
    for file in build.rglob("*"):
        if file.is_symlink():
            raise ValueError("Symlinks are not release assets")
        if file.is_file():
            paths[file.relative_to(build).as_posix()] = file
    if set(paths) != allowed:
        raise ValueError(f"Release file inventory differs: extra={sorted(set(paths)-allowed)}, missing={sorted(allowed-set(paths))}")
    manifest = json.loads(paths["manifest.json"].read_text(encoding="utf8"))
    version = manifest["version_name"]
    if not re.fullmatch(r"\d{4}\.[1-4]\.[1-7]\.(0|[1-9]\d*)", version):
        raise ValueError("Invalid release display version")
    if ".".join(str(int(n)) for n in version.split(".")) != manifest["version"]:
        raise ValueError("Numeric/display version mismatch")
    forbidden = re.compile(rb"(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|[EF]:[\\/](?:Cloud|Drew)[\\/])")
    for name, file in paths.items():
        if name.endswith((".js", ".json", ".html", ".css", ".ts", ".tsx", ".mjs")) and forbidden.search(file.read_bytes()):
            raise ValueError(f"Potential private data in release asset: {name}")
    output.mkdir(parents=True)
    archive = output / f"lyricvibe-{version}.zip"
    hashes = {}
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, file in sorted(paths.items()):
            data = file.read_bytes()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, data, compresslevel=9)
            hashes[name] = hashlib.sha256(data).hexdigest()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        assert set(zipped.namelist()) == allowed
        assert all(hashlib.sha256(zipped.read(name)).hexdigest() == sha for name, sha in hashes.items())
    receipt = {"version": version, "chromeVersion": manifest["version"], "sourceCommit": commit,
               "archive": archive.name, "sha256": digest, "bytes": archive.stat().st_size,
               "packageLockSha256": hashlib.sha256((source / "package-lock.json").read_bytes()).hexdigest(),
               "files": hashes}
    (output / "release.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf8")
    (output / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n", encoding="utf8")
    print(json.dumps({"version": version, "archive": str(archive), "sha256": digest, "files": len(hashes)}))
    return receipt


if __name__ == "__main__":
    package(*sys.argv[1:])
