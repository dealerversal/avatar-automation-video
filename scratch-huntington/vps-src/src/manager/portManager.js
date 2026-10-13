// src/manager/portManager.js
/**
 * Centralized dynamic port management across RDP and VPS machines.
 * Tracks allocated, active, and freed ports in MongoDB collection: 'system_ports'
 */

export const RESERVED_PORTS = new Set([
  3000,  // Frontend Dev Server
  3001,  // Admin App / Vite Secondary
  5000,  // Backend API
  5001,  // Supervisor / Base Project
  27017, // MongoDB
]);

export const PORT_START = 5101;
export const PORT_END = 5999;

let indexesCreated = false;

/**
 * Ensures required indexes on system_ports collection.
 */
export async function ensurePortIndexes(db) {
  if (indexesCreated) return;
  try {
    const col = db.collection('system_ports');
    await col.createIndex({ machineType: 1, machineId: 1, port: 1 }, { unique: true });
    await col.createIndex({ machineType: 1, machineId: 1, status: 1 });
    await col.createIndex({ instanceId: 1 });
    indexesCreated = true;
  } catch (err) {
    // Indexes might already exist or be initializing
  }
}

/**
 * Dynamically allocates a port for an instance on a specific machine.
 * Priority 1: Reuse an existing 'free' port on that machine (if local socket is also free).
 * Priority 2: Allocate the next lowest unallocated port >= 5101.
 */
export async function allocatePort({ machineType = 'rdp', machineId, instanceId, username, db, isPortFreeFn = null }) {
  await ensurePortIndexes(db);
  const cleanMachineId = (machineId || (machineType === 'rdp' ? 'azure-rdp-01' : 'dvnew')).toLowerCase().trim();
  const cleanInstanceId = instanceId ? instanceId.toLowerCase().trim() : null;
  const col = db.collection('system_ports');

  // 1. Check if this instance is already recorded with an active port
  if (cleanInstanceId) {
    const existing = await col.findOne({
      machineType,
      machineId: cleanMachineId,
      instanceId: cleanInstanceId,
      status: 'in_use'
    });
    if (existing && Number(existing.port) > 5001) {
      if (!isPortFreeFn || (await isPortFreeFn(Number(existing.port)))) {
        return Number(existing.port);
      }
    }
  }

  // 2. Look for an existing freed port for this machine to reuse
  const freedDocs = await col.find({
    machineType,
    machineId: cleanMachineId,
    status: 'free',
    port: { $gt: 5001 }
  }).sort({ port: 1 }).toArray();

  for (const doc of freedDocs) {
    const candidatePort = Number(doc.port);
    // Double check active instances in avatar_instances
    const inUseInInstances = await db.collection('avatar_instances').findOne({
      port: candidatePort,
      instanceId: { $ne: cleanInstanceId },
      status: { $ne: 'delete_requested' }
    });

    if (!inUseInInstances) {
      // If local socket check is available, verify OS socket is free
      if (isPortFreeFn && !(await isPortFreeFn(candidatePort))) {
        continue;
      }

      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'in_use',
            instanceId: cleanInstanceId,
            username: username || '',
            allocatedAt: new Date(),
            freedAt: null,
            updatedAt: new Date(),
          }
        }
      );
      console.log(`[PortManager] ♻️ Reused previously freed port ${candidatePort} for "${cleanInstanceId}" on ${machineType}:${cleanMachineId}`);
      return candidatePort;
    }
  }

  // 3. Find all ports in use across system_ports and avatar_instances for this machine
  const inUseDocs = await col.find({
    machineType,
    machineId: cleanMachineId,
    status: 'in_use'
  }, { projection: { port: 1 } }).toArray();

  const activeInstances = await db.collection('avatar_instances').find({
    port: { $exists: true, $ne: null },
    status: { $ne: 'delete_requested' },
    $or: [
      { rdpId: cleanMachineId },
      { vps: cleanMachineId }
    ]
  }, { projection: { port: 1 } }).toArray();

  const usedSet = new Set(RESERVED_PORTS);
  inUseDocs.forEach(d => usedSet.add(Number(d.port)));
  activeInstances.forEach(d => usedSet.add(Number(d.port)));

  let candidatePort = PORT_START;
  while (candidatePort <= PORT_END) {
    if (!usedSet.has(candidatePort)) {
      if (!isPortFreeFn || (await isPortFreeFn(candidatePort))) {
        break;
      }
    }
    candidatePort++;
  }

  // Register in system_ports
  await col.updateOne(
    { machineType, machineId: cleanMachineId, port: candidatePort },
    {
      $set: {
        machineType,
        machineId: cleanMachineId,
        port: candidatePort,
        status: 'in_use',
        instanceId: cleanInstanceId,
        username: username || '',
        allocatedAt: new Date(),
        freedAt: null,
        updatedAt: new Date(),
      }
    },
    { upsert: true }
  );

  console.log(`[PortManager] 🔌 Allocated new port ${candidatePort} for "${cleanInstanceId}" on ${machineType}:${cleanMachineId}`);
  return candidatePort;
}

/**
 * Releases a port and marks it as 'free' for future instance reuse.
 */
export async function releasePort({ machineType, machineId, instanceId, port, db }) {
  await ensurePortIndexes(db);
  const col = db.collection('system_ports');
  const query = {};

  if (instanceId) query.instanceId = instanceId.toLowerCase().trim();
  if (port) query.port = Number(port);
  if (machineId) query.machineId = machineId.toLowerCase().trim();
  if (machineType) query.machineType = machineType;

  const result = await col.updateMany(
    query,
    {
      $set: {
        status: 'free',
        instanceId: null,
        username: null,
        freedAt: new Date(),
        updatedAt: new Date(),
      }
    }
  );

  console.log(`[PortManager] 🔓 Released port(s) matching ${JSON.stringify(query)} — marked as free.`);
  return result.modifiedCount > 0;
}

/**
 * Returns summary of ports for a machine or all machines.
 */
export async function getPortsStatus({ machineId, machineType, db }) {
  await ensurePortIndexes(db);

  const query = {};
  if (machineId) query.machineId = machineId.toLowerCase().trim();
  if (machineType) query.machineType = machineType;

  const ports = await db.collection('system_ports').find(query).sort({ port: 1 }).toArray();

  const inUse = ports.filter(p => p.status === 'in_use');
  const free = ports.filter(p => p.status === 'free');

  return {
    totalAllocated: ports.length,
    inUseCount: inUse.length,
    freeCount: free.length,
    inUsePorts: inUse,
    freePorts: free,
    allPorts: ports,
  };
}
