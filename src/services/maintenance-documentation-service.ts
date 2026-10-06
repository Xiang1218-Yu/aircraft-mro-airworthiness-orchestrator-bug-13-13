import type { AirworthinessSignature, IndependentInspection, MaintenanceTaskCard } from '../domain/types.js';
import { Store } from '../store/store.js';

const TASK_ADVANCE: Record<MaintenanceTaskCard['status'], MaintenanceTaskCard['status'][]> = {
  OPEN: ['COMPLETED', 'WAIVED'],
  COMPLETED: [],
  WAIVED: [],
};

const INSPECTION_ADVANCE: Record<IndependentInspection['status'], IndependentInspection['status'][]> = {
  PENDING: ['PASSED', 'FAILED'],
  PASSED: [],
  FAILED: [],
};

/**
 * Ingests task-card execution receipts, mandatory independent-inspection
 * receipts and airworthiness signatures. Receipts may arrive concurrently with
 * each other and may be retried (duplicated); every operation runs inside the
 * store-wide critical section and is idempotent by receipt/card id.
 */
export class MaintenanceDocumentationService {
  constructor(private readonly store: Store) {}

  async applyTaskCardReceipt(receipt: MaintenanceTaskCard): Promise<'APPLIED' | 'DUPLICATE'> {
    return this.store.lock.runExclusive(() => {
      const order = this.store.workOrders.get(receipt.workOrderId);
      if (!order) throw new Error('work order not found');
      const existing = this.store.taskCards.get(receipt.id);
      if (existing) {
        // Retried receipt or a late out-of-order receipt: never move a terminal
        // card backwards, never emit duplicate audit/outbox.
        if (existing.status === receipt.status || !TASK_ADVANCE[existing.status].includes(receipt.status)) return 'DUPLICATE';
        existing.status = receipt.status;
        this.store.addAudit(order.tenantId, 'maintenance.task-card-updated', 'task-card', receipt.id, {
          workOrderId: order.id,
          status: receipt.status,
        });
        return 'APPLIED';
      }
      this.store.taskCards.set(receipt.id, { ...receipt });
      this.store.addAudit(order.tenantId, 'maintenance.task-card-received', 'task-card', receipt.id, {
        workOrderId: order.id,
        required: receipt.required,
        status: receipt.status,
      });
      return 'APPLIED';
    });
  }

  async applyInspectionReceipt(receipt: IndependentInspection): Promise<'APPLIED' | 'DUPLICATE'> {
    return this.store.lock.runExclusive(() => {
      const order = this.store.workOrders.get(receipt.workOrderId);
      if (!order) throw new Error('work order not found');
      const existing = this.store.inspections.get(receipt.id);
      if (existing) {
        if (existing.status === receipt.status || !INSPECTION_ADVANCE[existing.status].includes(receipt.status)) return 'DUPLICATE';
        existing.status = receipt.status;
        this.store.addAudit(order.tenantId, 'maintenance.inspection-updated', 'inspection', receipt.id, {
          workOrderId: order.id,
          status: receipt.status,
        });
        return 'APPLIED';
      }
      this.store.inspections.set(receipt.id, { ...receipt });
      this.store.addAudit(order.tenantId, 'maintenance.inspection-received', 'inspection', receipt.id, {
        workOrderId: order.id,
        required: receipt.required,
        status: receipt.status,
      });
      return 'APPLIED';
    });
  }

  async applySignatureReceipt(receipt: Omit<AirworthinessSignature, 'tenantId'>): Promise<'APPLIED' | 'DUPLICATE'> {
    return this.store.lock.runExclusive(() => {
      const order = this.store.workOrders.get(receipt.workOrderId);
      if (!order) throw new Error('work order not found');
      // A signature is an immutable signed statement: retried submission is a
      // duplicate and must not overwrite or re-audit the original.
      if (this.store.airworthinessSignatures.has(receipt.id)) return 'DUPLICATE';
      const signature: AirworthinessSignature = { ...receipt, tenantId: order.tenantId };
      this.store.airworthinessSignatures.set(receipt.id, signature);
      this.store.addAudit(order.tenantId, 'maintenance.airworthiness-signed', 'airworthiness-signature', receipt.id, {
        workOrderId: order.id,
        signer: receipt.signer,
        valid: receipt.valid,
      });
      return 'APPLIED';
    });
  }
}
