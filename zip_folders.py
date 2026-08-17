from pathlib import Path
import zipfile


# Folder chứa file script này
BASE_DIR = Path(__file__).resolve().parent

# Các folder không muốn đưa vào ZIP
IGNORE_DIRS = {
    ".git",
}

# Các extension không muốn đưa vào ZIP
IGNORE_EXTENSIONS = {
    ".zip",
}


def should_ignore(path: Path) -> bool:
    """Check whether a file/folder should be ignored."""
    if any(part in IGNORE_DIRS for part in path.parts):
        return True

    if path.is_file() and path.suffix.lower() in IGNORE_EXTENSIONS:
        return True

    return False


def zip_folder(folder: Path, output_zip: Path):
    """Zip a folder while excluding ignored files/folders."""

    with zipfile.ZipFile(
        output_zip,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as zip_file:

        for path in folder.rglob("*"):
            relative_path = path.relative_to(folder)

            if should_ignore(relative_path):
                continue

            if path.is_file():
                # Thêm folder gốc vào trong ZIP
                archive_path = folder.name / relative_path
                zip_file.write(path, archive_path)

    print(f"✅ ZIP DONE: {folder.name} -> {output_zip.name}")


def main():
    print(f"\n📂 Scanning: {BASE_DIR}\n")

    folders = [
        path
        for path in BASE_DIR.iterdir()
        if path.is_dir() and path.name not in IGNORE_DIRS
    ]

    if not folders:
        print("⚠️ Không tìm thấy folder nào.")
        return

    created = 0
    skipped = 0

    for folder in sorted(folders):
        output_zip = BASE_DIR / f"{folder.name}.zip"

        # Nếu ZIP đã tồn tại thì không zip lại
        if output_zip.exists():
            print(f"⏭️ SKIP: {folder.name} ({output_zip.name} đã tồn tại)")
            skipped += 1
            continue

        try:
            zip_folder(folder, output_zip)
            created += 1
        except Exception as error:
            print(f"❌ ERROR: {folder.name}: {error}")

            # Xóa file ZIP lỗi/dở nếu có
            if output_zip.exists():
                output_zip.unlink()

    print("\n" + "=" * 50)
    print(f"✅ Created : {created}")
    print(f"⏭️ Skipped : {skipped}")
    print("=" * 50)


if __name__ == "__main__":
    main()
