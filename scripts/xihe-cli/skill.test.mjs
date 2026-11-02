// PLAN-0628 M1: the `skill` CLI domain.
//
// The module takes an injected `fetchImpl`, so these tests need no HTTP server and no auth/login
// mock — the token is an argument here. (The login mock in xihe-cli.test.mjs belongs to the
// runCommand-level tests, where a real token has to be obtained; keeping that split means this file
// stays readable and my addition cannot destabilise the 171 KB suite.)
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSkill,
  deleteSkill,
  importSkills,
  listSkillBindings,
  listSkills,
  showSkill,
  unbindSkill,
} from './skill.mjs';

function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: response.status ?? 200,
      ok: (response.status ?? 200) < 400,
      text: async () => JSON.stringify(response.body ?? {}),
    };
  };
  return { calls, fetchImpl };
}

const base = { apiBase: 'http://127.0.0.1:9999', token: 'token-fixture' };

test('listSkills asks for the instance library by default and shapes {skills}', async () => {
  const { calls, fetchImpl } = recorder({
    body: { items: [{ skillId: 's1', name: 'writing' }] },
  });

  const data = await listSkills({ ...base, fetchImpl, options: {} });

  assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/v1/skills?definitionScope=instance');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-fixture');
  // Follows `provider list`'s `{connections: [...]}` shape rather than inventing a bare array.
  assert.deepEqual(data, { skills: [{ skillId: 's1', name: 'writing' }] });
});

test('listSkills requires --workspace for a workspace listing', async () => {
  const { fetchImpl } = recorder({ body: { items: [] } });

  await assert.rejects(
    () => listSkills({ ...base, fetchImpl, options: { '--scope': 'workspace' } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('listSkills rejects an unknown scope instead of silently defaulting', async () => {
  const { fetchImpl } = recorder({ body: { items: [] } });

  await assert.rejects(
    () => listSkills({ ...base, fetchImpl, options: { '--scope': 'everywhere' } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('showSkill adds includeBody only when asked', async () => {
  const { calls, fetchImpl } = recorder({ body: { skillId: 's1', name: 'writing' } });

  const plain = await showSkill({ ...base, fetchImpl, skillId: 's1', includeBody: false });
  const withBody = await showSkill({ ...base, fetchImpl, skillId: 's1', includeBody: true });

  assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/v1/skills/s1');
  assert.equal(calls[1].url, 'http://127.0.0.1:9999/api/v1/skills/s1?includeBody=true');
  assert.equal(plain.skill.skillId, 's1');
  assert.equal(withBody.skill.skillId, 's1');
});

test('listSkillBindings shapes {bindings}', async () => {
  const { calls, fetchImpl } = recorder({ body: { items: [{ bindingId: 'b1' }] } });

  const data = await listSkillBindings({ ...base, fetchImpl, skillId: 's1' });

  assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/v1/skills/s1/bindings');
  assert.deepEqual(data, { bindings: [{ bindingId: 'b1' }] });
});

test('importSkills posts the request untouched and reports the three result groups', async () => {
  const { calls, fetchImpl } = recorder({
    body: {
      results: [{ skillId: 's1', action: 'created' }],
      rejected: [{ code: 'SKILL_NAME_INVALID' }],
      summary: { created: 1, rejected: 1 },
    },
  });
  const request = { definitionScope: { type: 'instance' }, skills: [{ name: 'writing' }] };

  const data = await importSkills({ ...base, fetchImpl, request });

  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(data.results[0].action, 'created');
  assert.equal(data.rejected[0].code, 'SKILL_NAME_INVALID');
  assert.equal(data.summary.created, 1);
});

test('bindSkill omits scopeId for the instance tier and includes it for a workspace', async () => {
  const { calls, fetchImpl } = recorder({ body: { bindingId: 'b1' } });

  await bindSkill({
    ...base,
    fetchImpl,
    options: { '--skill': 's1', '--subject-id': 'u1' },
  });
  await bindSkill({
    ...base,
    fetchImpl,
    options: {
      '--skill': 's1', '--subject-id': 'u1',
      '--scope': 'workspace', '--workspace': 'w1',
    },
  });

  const instanceBody = JSON.parse(calls[0].init.body);
  const workspaceBody = JSON.parse(calls[1].init.body);
  assert.deepEqual(instanceBody, {
    skillId: 's1', subjectType: 'user', subjectId: 'u1', scopeType: 'instance',
  });
  assert.equal(workspaceBody.scopeId, 'w1');
  assert.equal(workspaceBody.scopeType, 'workspace');
});

test('bindSkill refuses an unknown subject type', async () => {
  const { fetchImpl } = recorder({ body: {} });

  await assert.rejects(
    () => bindSkill({
      ...base, fetchImpl, options: { '--skill': 's1', '--subject-id': 'u1', '--subject': 'group' },
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('deleteSkill demands confirmation when the caller did not pass --yes', async () => {
  const { calls, fetchImpl } = recorder({ status: 204 });

  // node:test stdin is not a TTY, so confirmAction refuses instead of blocking.
  await assert.rejects(
    () => deleteSkill({ ...base, fetchImpl, skillId: 's1', assumeYes: false }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.equal(calls.length, 0, 'nothing may be deleted before confirmation');

  const data = await deleteSkill({ ...base, fetchImpl, skillId: 's1', assumeYes: true });
  assert.equal(calls[0].init.method, 'DELETE');
  assert.deepEqual(data, { removed: 's1' });
});

test('unbindSkill has the same confirmation floor as deleteSkill', async () => {
  const { calls, fetchImpl } = recorder({ status: 204 });

  await assert.rejects(
    () => unbindSkill({ ...base, fetchImpl, bindingId: 'b1', assumeYes: false }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.equal(calls.length, 0);

  const data = await unbindSkill({ ...base, fetchImpl, bindingId: 'b1', assumeYes: true });
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/v1/skill-bindings/b1');
  assert.deepEqual(data, { removed: 'b1' });
});
