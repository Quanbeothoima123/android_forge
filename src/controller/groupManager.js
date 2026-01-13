// src/controller/groupManager.js
class GroupManager {
  constructor() {
    this.groups = new Map(); // groupId -> { id, name, devices:Set }
  }

  create(id, name) {
    if (!id) throw new Error("group id required");
    if (this.groups.has(id)) return this.groups.get(id);
    const g = { id, name: name || id, devices: new Set() };
    this.groups.set(id, g);
    return g;
  }

  remove(id) {
    this.groups.delete(id);
  }

  addDevice(groupId, deviceId) {
    const g = this.groups.get(groupId);
    if (!g) throw new Error("group not found");
    g.devices.add(deviceId);
  }

  removeDevice(groupId, deviceId) {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.devices.delete(deviceId);
  }

  list() {
    return Array.from(this.groups.values()).map((g) => ({
      id: g.id,
      name: g.name,
      devices: Array.from(g.devices),
    }));
  }

  get(id) {
    return this.groups.get(id) || null;
  }
}

module.exports = { GroupManager };
