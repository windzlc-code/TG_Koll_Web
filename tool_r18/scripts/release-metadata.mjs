import semver from "semver";

export function inspectReleaseMetadata({
  packageJsonVersion,
  versionFileContents,
}) {
  const issues = [];
  const normalizedVersion = String(packageJsonVersion || "").trim();

  if (!semver.valid(normalizedVersion)) {
    issues.push("package.json.version must be a valid semver version");
  }

  if (versionFileContents != null) {
    issues.push("VERSION file is not supported in this repository; use package.json.version only");
  }

  return {
    ok: issues.length === 0,
    authoritativeSource: "package.json.version",
    normalizedVersion,
    issues,
  };
}
