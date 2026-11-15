/**
 * 测试夹具：把旧式 `agentTeams` 假服务适配成 rc.2 `subagents` 服务。
 * 生产代码已不再有 legacy 分支；这里只让既有测试的成员/消息夹具继续可用。
 */
export function subagentsFromLegacy(legacy) {
  const members = () => {
    try {
      const rows = legacy?.listMembers?.({});
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  };
  const byId = (id) => members().find((member) => member?.id === id);
  const byName = (name) => members().find((member) => member?.name === name);
  const membershipOf = (agent) => {
    try { return legacy?.tryMembership?.(agent); } catch { return undefined; }
  };
  const service = {
    calls: legacy?.calls,
    /** `agents.get(id).status` 夹具：让 listMembers 的 running/inactive 与旧 members 表一致。 */
    agentsService: { get: (id) => { const member = byId(id); return member === undefined ? undefined : { status: member.status === 'running' ? 'running' : 'idle' }; } },
    rootOf(agent) {
      const membership = membershipOf(agent);
      if (membership?.root !== undefined && membership?.root !== null) return membership.root;
      // 旧夹具常只给 role/name，没有 root：为 teammate 造一个合成 root（id 用 parentSession/lead）。
      if (membership?.role === 'teammate') return { session: { id: agent?.session?.header?.parentSession ?? 'lead' } };
      return agent;
    },
    namesOf(agent) {
      const membership = membershipOf(agent);
      if (membership === undefined || membership === null) throw new Error('no membership');
      return {
        self: membership.role === 'lead' ? 'lead' : (membership.name ?? agent?.session?.id),
        ...(membership.role === 'teammate' ? { parent: 'lead' } : {}),
      };
    },
    async listDescendants(rootId) {
      return members()
        .filter((member) => member !== null && member !== undefined && member.role !== 'lead' && member.id !== rootId)
        .map((member) => ({
          kind: 'child', id: member.id, parentId: rootId, depth: 1, mode: 'continuable',
          path: member.name, name: member.name, label: member.description,
          activity: member.status === 'running' ? 'running' : 'idle',
        }));
    },
    async resolveName(_caller, name) { return byName(name)?.id; },
    statusOf(id) { return byId(id)?.status; },
    async sendMessage(caller, targetId, blocks, options) {
      const member = byId(targetId);
      if (typeof legacy?.sendMessage === 'function') {
        return legacy.sendMessage(caller, { target: member?.name ?? targetId, content: blocks, signal: options?.signal });
      }
      return { messageId: 'm1' };
    },
    interrupt(id, options) {
      const member = byId(id);
      if (typeof legacy?.interrupt === 'function') return legacy.interrupt(options?.agent ?? {}, member?.name ?? id);
      return { previousStatus: 'running' };
    },
    getProvider(name) { return name === 'spawn-in-process' ? { id: name } : undefined; },
    async startActivation(request) {
      if (typeof legacy?.spawnTeammate !== 'function') throw new Error('spawnTeammate unavailable');
      const result = await legacy.spawnTeammate(request.parent, {
        name: request.name,
        description: request.label,
        prompt: request.prompt,
        context: 'fresh',
        provider: request.provider,
        signal: request.signal,
      });
      const member = result?.member;
      if (member === undefined || member === null) throw new Error('spawn failed');
      return { childId: member.id, name: member.name, result: Promise.resolve({ stopReason: 'done' }) };
    },
    async drainDescendants() {},
    async listChildren(rootId) {
      return (await service.listDescendants(rootId)).map((entry) => ({ id: entry.id, mode: entry.mode, label: entry.label, activity: entry.activity }));
    },
  };
  return service;
}
