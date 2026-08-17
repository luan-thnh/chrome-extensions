from pathlib import Path
import zipfile


BASE_DIR = Path(__file__).resolve().parent

IGNORE_DIRS = {
    ".git",
}

IGNORE_EXTENSIONS = {
    ".zip",
}


def should_ignore(path: Path) -> bool:
    if any(part in IGNORE_DIRS for part in path.parts):
        return True

    if path.is_file() and path.suffix.lower() in IGNORE_EXTENSIONS:
        return True

    return False


def zip_folder(folder: Path, output_zip: Path):
    # Nếu ZIP cũ tồn tại -> xóa trước để tạo bản mới sạch hoàn toàn
    if output_zip.exists():
        output_zip.unlink()

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
                archive_path = folder.name / relative_path
                zip_file.write(path, archive_path)

    print(f"✅ UPDATED: {folder.name} -> {output_zip.name}")


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

    success = 0
    failed = 0

    for folder in sorted(folders):
        output_zip = BASE_DIR / f"{folder.name}.zip"

        try:
            zip_folder(folder, output_zip)
            success += 1

        except Exception as error:
            print(f"❌ ERROR: {folder.name}: {error}")
            failed += 1

            # Xóa ZIP lỗi nếu quá trình zip bị fail
            if output_zip.exists():
                output_zip.unlink()

    print("\n" + "=" * 50)
    print(f"✅ Updated: {success}")
    print(f"❌ Failed : {failed}")
    print("=" * 50)


if __name__ == "__main__":
    main()