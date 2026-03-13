module.exports = {
  testMatch: ['**/__tests__/**/*.test.{js,ts,tsx}'],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest',
  },
  // Allow babel to transform ESM modules from expo and supabase
  transformIgnorePatterns: ['/node_modules/(?!(expo|@expo|@supabase)/)'],
  // Resolve .js imports to .ts source files (TypeScript ESM convention)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
