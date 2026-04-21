import { execSync } from "node:child_process";

type BuildInfo = {
  shortSha: string | null;
  timestamp: string;
  label: string;
};

const formatBuildTimestamp = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");

const readShortSha = (): string | null => {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const buildDate = new Date();
const timestamp = `build ${formatBuildTimestamp(buildDate)}`;
const shortSha = readShortSha();

export const buildInfo: BuildInfo = {
  shortSha,
  timestamp,
  label: shortSha ? `${timestamp} \u00b7 ${shortSha}` : timestamp,
};
