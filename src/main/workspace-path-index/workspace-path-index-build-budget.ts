import { WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES } from '../../shared/__fixtures__/workspace-path-memory-measurement'

/**
 * Why: catalog builds are bounded by the host build-peak allowance, while the smaller root budget caps
 * retained bytes. Binding the builder to the root budget spilled roots whose retained catalog fits it.
 */
export const WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES =
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES
