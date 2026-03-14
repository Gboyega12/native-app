module.exports = {
  preset: 'react-native',
  testMatch: ['**/__tests__/**/*.test.{js,ts,tsx}'],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest',
  },
  // Allow babel to transform ESM modules from expo and supabase
  transformIgnorePatterns: [
    '/node_modules/(?!(expo|@expo|@supabase|react-native|@react-native|@react-native-async-storage|@testing-library)/)',
  ],
  // Resolve .js imports to .ts source files (TypeScript ESM convention)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/$1',
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock.js',
  },
};
