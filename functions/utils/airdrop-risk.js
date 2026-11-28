// Metadata-based screening. A flag is a reason to ask the receiver, not a malware verdict.
const ACTIVE_EXTENSIONS = new Set(
  'exe msi msp msix appx app apk aab ipa deb rpm pkg dmg iso img com scr cpl dll bat cmd ps1 vbs vbe js jse mjs cjs ws wsf wsh sh bash zsh fish command py rb pl jar hta html htm shtml svg lnk url reg desktop docm dotm xlsm xltm xlam xlsb pptm potm ppam ppsm doc xls ppt'.split(' ')
);
const ARCHIVE_EXTENSIONS = new Set('zip rar 7z tar gz tgz bz2 tbz2 xz cab zst'.split(' '));
const ACTIVE_TYPES = /^(?:text\/(?:html|javascript|vbscript|x-shellscript|x-python)|image\/svg\+xml|application\/(?:javascript|x-javascript|x-msdownload|x-msdos-program|x-dosexec|vnd\.microsoft\.portable-executable|x-executable|x-sh|x-shellscript|java-archive|vnd\.android\.package-archive|x-msi|vnd\.apple\.installer\+xml|x-apple-diskimage|vnd\.ms-(?:excel|word|powerpoint)\..*macroenabled\.12))$/i;
const ARCHIVE_TYPES = /^(?:application\/(?:zip|x-zip-compressed|vnd\.rar|x-rar-compressed|x-7z-compressed|x-tar|gzip|x-gzip|x-bzip2|x-xz|zstd))$/i;
const DIRECTION_OR_CONTROL = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function assessAirdropFiles(files) {
  return files.flatMap((file) => {
    const name = String(file?.name || '未命名文件');
    const displayName = name.replace(DIRECTION_OR_CONTROL, '�');
    const normalized = displayName.normalize('NFKC').toLowerCase().replace(/[.\s]+$/u, '');
    const parts = normalized.split('.');
    const extension = parts.length > 1 ? parts.at(-1) : '';
    const type = String(file?.type || '').split(';', 1)[0].trim();
    const reasons = [];
    if (ACTIVE_EXTENSIONS.has(extension) || ACTIVE_TYPES.test(type)) reasons.push('active');
    if (ARCHIVE_EXTENSIONS.has(extension) || ARCHIVE_TYPES.test(type)) reasons.push('archive');
    if (displayName !== name || parts.slice(1, -1).some(part => ACTIVE_EXTENSIONS.has(part))) reasons.push('filename');
    return reasons.length ? [{ name: displayName, reasons }] : [];
  });
}
