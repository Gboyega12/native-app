module.exports = {
  testMatch: ['**/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  // Allow babel to transform ESM modules from expo and supabase
  transformIgnorePatterns: ['/node_modules/(?!(expo|@expo|@supabase)/)'],
};
