/**
 * Which OApp the DVN is wired to, in one place.
 *
 * Wiring calls `EndpointV2.setConfig(oapp, lib, params)`, which only the OApp or its delegate may
 * do — so the OApp named here has to be one the signing key controls. Switching targets therefore
 * means switching this value, and it is referenced by the LayerZero config, the demo tasks, and
 * the preflight check so they cannot drift apart.
 *
 * `ToyOFT` at 0xdEc1591D39ECb8278d1a2256a5BF17507A375F00 is owned by a key held elsewhere
 * (0x69bd4d7e…210c), so it cannot be wired from this repo's deployer. `MyOFT` is deployed by, and
 * owned by, whoever runs the deploy — which is what makes it usable for testing.
 *
 * To point back at ToyOFT once its delegate is available, set OAPP_CONTRACT=ToyOFT (or change the
 * default below). Nothing else needs editing.
 */
export const OAPP_CONTRACT = (process.env.OAPP_CONTRACT ?? '').trim() || 'MyOFT'
