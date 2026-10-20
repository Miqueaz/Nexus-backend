/**
 * Contratos de infraestructura (duck typing, sin dependencias de Mongo/HTTP).
 *
 * UnitOfWork.run(async tx => result): transacción; reintenta conflictos transitorios.
 * tx.get(collection,id), tx.find(collection,filter), tx.insert(collection,data),
 * tx.update(collection,id,expectedRevision,patch): siempre limitados a businessId.
 * tx.changes: cambios before/after que el adaptador de auditoría persistirá.
 *
 * InventoryPort.prepare(tx,lines): valida existencias y devuelve snapshots.
 * InventoryPort.consume(tx,lines): registra salidas de artículos contables.
 * FinancePort.post(tx,{walletId,amountMinor,kind,category,reference,...}): asienta y actualiza saldo.
 * ContactsPort.assertCustomer(tx,id): valida pertenencia al negocio.
 * SalesPort.create(tx,input): crea venta, usa inventario y finanzas en la misma tx.
 * AuditPort.append(tx,context,action): persiste cambios; nunca llamadas de red en tx.
 *
 * Composition root: src/container.js. Dominio solo recibe estos contratos.
 */
export const roles = Object.freeze(['owner', 'editor', 'viewer']);
