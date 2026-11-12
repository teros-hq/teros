/**
 * jest-dom matcher types for THIS package's vitest copy.
 *
 * The monorepo has two vitest installs (root 2.x, packages/app 3.x).
 * @testing-library/jest-dom lives at the root, so its bundled
 * `declare module 'vitest'` augmentation lands on the root copy and the
 * app's tests (which resolve packages/app/node_modules/vitest) never see
 * matchers like toBeInTheDocument. Re-apply the augmentation from inside
 * the app so it targets the right copy.
 */

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
