import { describe, expect, it } from 'vitest';

import {
  evaluateCurrentHostCompatibility,
  evaluateHostCompatibility,
} from '../../src/integration/compatibility.js';

describe('host compatibility', () => {
  it.each([
    ['22.19.0', '0.84.1'],
    ['22.19.1', '0.84.1+local.1'],
    ['23.0.0', '0.84.99'],
  ])('supports Node %s with Pi %s', (nodeVersion, piVersion) => {
    const result = evaluateHostCompatibility({ nodeVersion, piVersion });

    expect(result).toEqual({
      supported: true,
      node: {
        target: 'node',
        detectedVersion: nodeVersion,
        supportedRange: '>=22.19.0',
        status: 'supported',
        supported: true,
        reason: 'supported',
      },
      pi: {
        target: 'pi',
        detectedVersion: piVersion,
        supportedRange: '>=0.84.1 <0.85.0',
        status: 'supported',
        supported: true,
        reason: 'supported',
      },
      unsupportedTargets: [],
    });
  });

  it('rejects Node below the exact minimum', () => {
    const result = evaluateHostCompatibility({ nodeVersion: '22.18.9', piVersion: '0.84.1' });

    expect(result.supported).toBe(false);
    expect(result.node).toMatchObject({
      detectedVersion: '22.18.9',
      status: 'unsupported',
      reason: 'below_minimum',
    });
    expect(result.unsupportedTargets).toEqual(['node']);
  });

  it.each([
    ['0.84.0', 'below_minimum'],
    ['0.85.0', 'at_or_above_maximum'],
    ['1.0.0', 'at_or_above_maximum'],
  ] as const)('rejects Pi %s with reason %s', (piVersion, reason) => {
    const result = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion });

    expect(result.supported).toBe(false);
    expect(result.pi).toMatchObject({ status: 'unsupported', reason });
    expect(result.unsupportedTargets).toEqual(['pi']);
  });

  it('allows an unresolved Pi version as required by FR-001', () => {
    const result = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: undefined });

    expect(result.supported).toBe(true);
    expect(result.pi).toEqual({
      target: 'pi',
      detectedVersion: undefined,
      supportedRange: '>=0.84.1 <0.85.0',
      status: 'unresolved',
      supported: false,
      reason: 'version_unresolved',
    });
    expect(result.unsupportedTargets).toEqual([]);
  });

  it.each([
    ['node', '22.19.0-rc.1'],
    ['pi', '0.84.2-beta.1'],
  ] as const)('rejects a %s prerelease without throwing', (target, version) => {
    const result = evaluateHostCompatibility({
      nodeVersion: target === 'node' ? version : '22.19.0',
      piVersion: target === 'pi' ? version : '0.84.1',
    });

    expect(result.supported).toBe(false);
    expect(result[target]).toMatchObject({
      detectedVersion: version,
      status: 'unsupported',
      reason: 'prerelease_version',
    });
  });

  it.each(['', 'v22.19.0', '22.19', '22.019.0', '22.19.0.1', 'not-a-version'])(
    'returns a stable unsupported Node fact for malformed %j',
    (nodeVersion) => {
      const result = evaluateHostCompatibility({ nodeVersion, piVersion: '0.84.1' });

      expect(result.node).toMatchObject({
        detectedVersion: nodeVersion,
        supportedRange: '>=22.19.0',
        status: 'unsupported',
        supported: false,
        reason: 'malformed_version',
      });
    },
  );

  it.each(['', 'v0.84.1', '0.84', '0.084.1', '0.84.1.0', 'unknown'])(
    'returns a stable unsupported Pi fact for malformed %j',
    (piVersion) => {
      const result = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion });

      expect(result.pi).toMatchObject({
        detectedVersion: piVersion,
        supportedRange: '>=0.84.1 <0.85.0',
        status: 'unsupported',
        supported: false,
        reason: 'malformed_version',
      });
    },
  );

  it('reports both unsupported targets in stable order', () => {
    const result = evaluateHostCompatibility({ nodeVersion: '20.0.0', piVersion: '0.85.0' });

    expect(result.supported).toBe(false);
    expect(result.unsupportedTargets).toEqual(['node', 'pi']);
  });

  it('keeps current-host evaluation injectable', () => {
    expect(
      evaluateCurrentHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
    ).toEqual(evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }));
  });

  it('uses the public installed Pi VERSION through the narrow default source', () => {
    const result = evaluateCurrentHostCompatibility();

    expect(result.supported).toBe(true);
    expect(result.node.detectedVersion).toBe('22.19.0');
    expect(result.pi.detectedVersion).toBe('0.84.1');
  });
});
