import { MroApplication } from './app.js';
import type { PartStock, WorkOrder } from './domain/types.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}`, detail ?? '');
  }
}

async function expectReject(name: string, run: () => Promise<unknown>, messageIncludes?: string): Promise<void> {
  try {
    await run();
    check(name, false, 'did not throw');
  } catch (error) {
    const ok = !messageIncludes || (error instanceof Error && error.message.includes(messageIncludes));
    check(name, ok, error instanceof Error ? error.message : error);
  }
}

function freshApp(workOrderId = 'wo_test'): MroApplication {
  const app = new MroApplication();
  const tenantId = 'tenant_test';
  const stock: PartStock = {
    id: 'stock_1', tenantId, partNumber: 'PUMP-1', kind: 'SERIALIZED', serialNumber: 'SN-1', lotNumber: 'L1',
    quantity: 2, reserved: 0, qualityStatus: 'RELEASED', certificateVersion: 1, certificateStatus: 'APPROVED',
    certificateExpiresOn: '2030-01-01', certificateTimeZone: 'UTC', location: 'A', version: 1,
  };
  app.store.stocks.set(stock.id, stock);
  const order: WorkOrder = {
    id: workOrderId, tenantId, aircraftId: 'ac1', status: 'OPEN',
    requiredParts: [{ partNumber: 'PUMP-1', quantity: 1, serialNumbers: ['SN-1'] }],
    reservations: [], installedParts: [], lastEventSequence: {}, processedEventIds: [], version: 1,
  };
  app.store.workOrders.set(workOrderId, order);
  return app;
}

async function reserveAndComplete(app: MroApplication, workOrderId: string): Promise<void> {
  const order = app.store.workOrders.get(workOrderId)!;
  await app.inventory.reserveForWorkOrder(order);
  order.status = 'COMPLETED';
}

const iso = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60000).toISOString();

// 1. Gate failures -----------------------------------------------------------
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  // inspection still PENDING, no signature
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PENDING' });
  await expectReject('blocks release when inspection pending', () => app.maintenanceRelease.release(wo), 'inspections are pending');
  check('no state/audit/outbox on gate failure', app.store.workOrders.get(wo)!.status === 'COMPLETED'
    && !app.store.audit.some((a) => a.action === 'work-order.released')
    && !app.store.outbox.some((m) => m.topic === 'mro.work-order-released'));
}
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'OPEN' });
  await expectReject('blocks release when required task open', () => app.maintenanceRelease.release(wo), 'tasks are incomplete');
}
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'FAILED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  await expectReject('blocks release when mandatory inspection FAILED', () => app.maintenanceRelease.release(wo), 'inspections failed');
}
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: false, signedAt: iso() });
  await expectReject('blocks release when signature invalid', () => app.maintenanceRelease.release(wo), 'no current valid');
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig2', workOrderId: wo, signer: 'b', valid: true, signedAt: iso(5) });
  await expectReject('blocks release when signature is in the future', () => app.maintenanceRelease.release(wo), 'no current valid');
}
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  // non-required OPEN task must not block; non-required inspection ignored
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: false, status: 'OPEN' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: false, status: 'PENDING' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  const r = await app.maintenanceRelease.release(wo);
  check('releases with only non-required items outstanding', r.duplicate === false && app.store.workOrders.get(wo)!.status === 'CLOSED');
}

// 2. Successful release: issue + outbox + customer notification --------------
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  const result = await app.maintenanceRelease.release(wo);
  check('release returns non-duplicate result', result.duplicate === false && result.issuedReservationIds.length === 1);
  const order = app.store.workOrders.get(wo)!;
  check('order CLOSED', order.status === 'CLOSED');
  const stock = app.store.stocks.get('stock_1')!;
  check('stock issued (quantity/reserved decremented)', stock.quantity === 1 && stock.reserved === 0);
  check('reservation ISSUED', app.store.reservations.get(order.reservations[0]!)!.status === 'ISSUED');
  check('exactly one release audit', app.store.audit.filter((a) => a.action === 'work-order.released').length === 1);
  check('one released outbox', app.store.outbox.filter((m) => m.topic === 'mro.work-order-released').length === 1);
  check('one customer notification outbox', app.store.outbox.filter((m) => m.topic === 'mro.customer-release-notification').length === 1);
  check('one stock-issued outbox', app.store.outbox.filter((m) => m.topic === 'mro.stock-issued').length === 1);
  check('release record persisted', app.store.maintenanceReleases.has(wo));
}

// 3. Repeated release is idempotent ------------------------------------------
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  const first = await app.maintenanceRelease.release(wo);
  const auditBefore = app.store.audit.length;
  const outboxBefore = app.store.outbox.length;
  const stockBefore = { ...app.store.stocks.get('stock_1')! };
  const second = await app.maintenanceRelease.release(wo);
  const third = await app.maintenanceRelease.release(wo);
  check('duplicate flagged', second.duplicate === true && third.duplicate === true);
  check('same releasedAt returned', second.releasedAt === first.releasedAt && third.releasedAt === first.releasedAt);
  check('same issued reservations returned', JSON.stringify(second.issuedReservationIds) === JSON.stringify(first.issuedReservationIds));
  check('no extra audit', app.store.audit.length === auditBefore);
  check('no extra outbox (no re-issue / re-notify)', app.store.outbox.length === outboxBefore);
  check('stock untouched by retries', app.store.stocks.get('stock_1')!.quantity === stockBefore.quantity
    && app.store.stocks.get('stock_1')!.reserved === stockBefore.reserved);
}

// 4. Concurrent releases: exactly one wins -----------------------------------
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  const results = await Promise.all([
    app.maintenanceRelease.release(wo),
    app.maintenanceRelease.release(wo),
    app.maintenanceRelease.release(wo),
  ]);
  check('exactly one non-duplicate under concurrency', results.filter((r) => !r.duplicate).length === 1);
  check('others see duplicate', results.filter((r) => r.duplicate).length === 2);
  check('single release audit/outbox/notification',
    app.store.audit.filter((a) => a.action === 'work-order.released').length === 1
    && app.store.outbox.filter((m) => m.topic === 'mro.work-order-released').length === 1
    && app.store.outbox.filter((m) => m.topic === 'mro.customer-release-notification').length === 1
    && app.store.stocks.get('stock_1')!.quantity === 1);
}

// 5. Atomic rollback when commit phase fails ---------------------------------
{
  const app = freshApp();
  const wo = 'wo_test';
  await reserveAndComplete(app, wo);
  await app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' });
  await app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' });
  await app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() });
  // Force addOutbox to throw midway through the commit (after stock issue +
  // release audit). Simulates an infrastructure failure during commit.
  const originalAddOutbox = app.store.addOutbox.bind(app.store);
  let calls = 0;
  app.store.addOutbox = (tenantId: string, topic: string, aggregateId: string, payload: unknown) => {
    calls += 1;
    if (calls === 2) throw new Error('outbox broker down');
    return originalAddOutbox(tenantId, topic, aggregateId, payload);
  };
  await expectReject('release failure propagates', () => app.maintenanceRelease.release(wo), 'outbox broker down');
  check('order rolled back to COMPLETED', app.store.workOrders.get(wo)!.status === 'COMPLETED');
  check('stock mutation rolled back', app.store.stocks.get('stock_1')!.quantity === 2 && app.store.stocks.get('stock_1')!.reserved === 1);
  check('reservation rolled back to ACTIVE', app.store.reservations.get(app.store.workOrders.get(wo)!.reservations[0]!)!.status === 'ACTIVE');
  check('no partial release audit', !app.store.audit.some((a) => a.action === 'work-order.released'));
  check('no partial outbox left', app.store.outbox.filter((m) => m.topic === 'mro.stock-issued' || m.topic === 'mro.work-order-released' || m.topic === 'mro.customer-release-notification').length === 0);
  check('no release record', !app.store.maintenanceReleases.has(wo));
  // retry after recovery succeeds
  app.store.addOutbox = originalAddOutbox;
  const retry = await app.maintenanceRelease.release(wo);
  check('retry after recovered failure succeeds once', retry.duplicate === false && app.store.workOrders.get(wo)!.status === 'CLOSED');
}

// 6. Concurrent receipts (task/inspection/signature) + retried duplicates ----
{
  const app = freshApp();
  const wo = 'wo_test';
  const outcomes = await Promise.all([
    app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' }),
    app.maintenanceDocs.applyTaskCardReceipt({ id: 'tc1', workOrderId: wo, required: true, status: 'COMPLETED' }),
    app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PENDING' }),
    app.maintenanceDocs.applyInspectionReceipt({ id: 'ii1', workOrderId: wo, required: true, status: 'PASSED' }),
    app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() }),
    app.maintenanceDocs.applySignatureReceipt({ id: 'sig1', workOrderId: wo, signer: 'a', valid: true, signedAt: iso() }),
  ]);
  check('receipts ingest concurrently without corruption',
    app.store.taskCards.get('tc1')!.status === 'COMPLETED'
    && app.store.inspections.get('ii1')!.status === 'PASSED'
    && app.store.airworthinessSignatures.has('sig1'));
  check('retried task receipt is DUPLICATE', outcomes[1] === 'DUPLICATE');
  check('status advance APPLIED once, signature duplicate', outcomes.includes('DUPLICATE'));
  check('single received/updated audits per entity',
    app.store.audit.filter((a) => a.entity === 'task-card').length === 1
    && app.store.audit.filter((a) => a.entity === 'airworthiness-signature').length === 1);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
if (failures > 0) throw new Error(`${failures} test(s) failed`);
