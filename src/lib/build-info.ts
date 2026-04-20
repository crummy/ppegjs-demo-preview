import { execSync } from "node:child_process";

type BuildInfo = {
  shortSha: string | null;
  timestamp: number; // unix millis
};

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
const shortSha = readShortSha();

export const buildInfo: BuildInfo = {
  shortSha,
  timestamp: buildDate.getTime(),
};
