import type {
  AirworthinessSignature,
  AuditRecord,
  CertificateRecord,
  CoreReturn,
  CustomsDeclaration,
  InstalledPart,
  LedgerEntry,
  OutboxMessage,
  PartStock,
  Reservation,
  WorkOrder,
  ExternalEvent,
} from '../domain/types.js';

class Mutex {
  private tail = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export class Store {
  readonly stocks = new Map<string, PartStock>();
  readonly workOrders = new Map<string, WorkOrder>();
  readonly reservations = new Map<string, Reservation>();
  readonly certificates = new Map<string, CertificateRecord>();
  readonly customs = new Map<string, CustomsDeclaration>();
  readonly coreReturns = new Map<string, CoreReturn>();
  readonly installedParts = new Map<string, InstalledPart>();
  readonly outbox: OutboxMessage[] = [];
  readonly audit: AuditRecord[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly externalEvents = new Map<string, ExternalEvent>();
  readonly lock = new Mutex();
  private sequence = 0;

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  addAudit(tenantId: string, action: string, entity: string, entityId: string, metadata: Record<string, string | number | boolean> = {}): string {
    const id = this.nextId('audit');
    this.audit.push({ id, tenantId, action, entity, entityId, metadata, createdAt: this.now() });
    return id;
  }

  addOutbox(tenantId: string, topic: string, aggregateId: string, payload: unknown): string {
    const id = this.nextId('outbox');
    this.outbox.push({ id, tenantId, topic, aggregateId, payload: JSON.stringify(payload), status: 'PENDING', createdAt: this.now() });
    return id;
  }

  addLedger(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): void {
    this.ledger.push({ ...entry, id: this.nextId('ledger'), createdAt: this.now() });
  }

  /**
   * Run `work` exclusively against the store. Audit/outbox/ledger writes made
   * inside only survive if `work` returns; when it throws they are rolled back,
   * so a failed state transition can never leave a half-written audit trail or
   * Outbox message.
   */
  async transact<T>(work: () => T | Promise<T>): Promise<T> {
    return this.lock.runExclusive(async () => {
      const auditSize = this.audit.length;
      const outboxSize = this.outbox.length;
      const ledgerSize = this.ledger.length;
      try {
        return await work();
      } catch (error) {
        this.audit.length = auditSize;
        this.outbox.length = outboxSize;
        this.ledger.length = ledgerSize;
        throw error;
      }
    });
  }

  readonly taskCards = new Map<string, import('../domain/types.js').MaintenanceTaskCard>();
  readonly inspections = new Map<string, import('../domain/types.js').IndependentInspection>();
  readonly airworthinessSignatures = new Map<string, AirworthinessSignature>();
}
