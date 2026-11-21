"use strict";

const path = require("node:path");
const fs = require("node:fs");

// The app ships a single icon (no runtime variants): full-canvas macOS PNGs
// under icons/variants/macos/, desktop PNGs under icons/variants/, falling
// back to the packaged icon PNGs when the variant assets are missing.
let preferPublicSources = false;
let useMacIconSources = false;
let currentIconPath = null;

function isPackagedApp(app) {
  try {
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

function pickExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildSourceCandidates(appPath, relativeParts) {
  const publicCandidate = path.join(appPath, "public", ...relativeParts);
  const distCandidate = path.join(appPath, "dist", ...relativeParts);
  return preferPublicSources
    ? [publicCandidate, distCandidate]
    : [distCandidate, publicCandidate];
}

function resolveOriginalIconPath(appPath) {
  const primaryParts = useMacIconSources
    ? ["icons", "variants", "macos", "original.png"]
    : ["icons", "variants", "original.png"];
  const candidates = useMacIconSources
    ? buildSourceCandidates(appPath, primaryParts)
    : [
        ...buildSourceCandidates(appPath, primaryParts),
        ...buildSourceCandidates(appPath, ["icon-win.png"]),
        ...buildSourceCandidates(appPath, ["icon.png"]),
      ];
  return pickExistingPath(candidates) || candidates[0];
}

function initializeAppIconManager(appPath, options = {}) {
  preferPublicSources = options.preferPublic === true;
  useMacIconSources = options.isMac === true;
  currentIconPath = resolveOriginalIconPath(appPath);
  return currentIconPath;
}

function getAppIconPath(appPath) {
  if (!currentIconPath) {
    return initializeAppIconManager(appPath);
  }
  return currentIconPath;
}

module.exports = {
  initializeAppIconManager,
  getAppIconPath,
  resolveOriginalIconPath,
};
