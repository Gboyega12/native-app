// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Allow .js imports to resolve to .ts source files.
// Vercel's serverless function compiler uses node16 module resolution which
// requires .js extensions on relative imports. Metro doesn't resolve .js → .ts
// by default, so we add a custom resolver to handle this.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // If the import ends with .js, try .ts first
  if (moduleName.endsWith('.js')) {
    const tsName = moduleName.replace(/\.js$/, '.ts');
    try {
      return context.resolveRequest(context, tsName, platform);
    } catch {
      // Fall through to default resolution
    }
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
