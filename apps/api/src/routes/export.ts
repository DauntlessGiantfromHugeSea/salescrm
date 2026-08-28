import type { FastifyInstance, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { DEAL_STAGE_LABELS, PROJECT_CONTACT_ROLE_LABELS, PROJECT_STAGE_LABELS } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { currentUser, requireUser } from '../auth/session.js';
import { contactDisplayName } from '../domain/upsert.js';
import { dealVisibilityFilter, projectVisibilityFilter } from './helpers.js';

/**
 * Excel-Export (Kapitel 10.3 und 12).
 * Bewusst als Datei und nicht als Report im Dashboard: die Listen werden
 * ausgedruckt, weitergereicht und in Besprechungen benutzt.
 */
export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/export/deals.xlsx', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const query = z.object({ openOnly: z.coerce.boolean().default(true) }).parse(request.query);
    const visibility = await dealVisibilityFilter(user);

    const deals = await prisma.deal.findMany({
      where: {
        AND: [
          visibility,
          query.openOnly ? { isOpen: true, stage: { notIn: ['WON', 'LOST'] } } : {},
        ],
      },
      include: {
        owner: { select: { displayName: true } },
        company: { select: { name: true } },
        contact: { select: { firstName: true, lastName: true, displayName: true, email: true, phone: true } },
        project: { select: { number: true, name: true } },
      },
      orderBy: [{ stage: 'asc' }, { lastContactAt: 'asc' }],
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AI Sales Acquisition System';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Offene Vorgänge');

    sheet.columns = [
      { header: 'Projekt-Nr.', key: 'projectNumber', width: 14 },
      { header: 'Projekt', key: 'projectName', width: 30 },
      { header: 'Vorgang', key: 'title', width: 38 },
      { header: 'Status', key: 'stage', width: 20 },
      { header: 'Firma', key: 'company', width: 28 },
      { header: 'Ansprechpartner', key: 'contact', width: 24 },
      { header: 'E-Mail', key: 'email', width: 30 },
      { header: 'Telefon', key: 'phone', width: 18 },
      { header: 'Bearbeiter', key: 'owner', width: 20 },
      { header: 'Nächste Aktion', key: 'nextAction', width: 40 },
      { header: 'Fällig am', key: 'dueDate', width: 14 },
      { header: 'Letzter Kontakt', key: 'lastContact', width: 16 },
      { header: 'Tage ohne Antwort', key: 'daysSilent', width: 18 },
      { header: 'Warum offen', key: 'reasons', width: 46 },
    ];

    for (const deal of deals) {
      sheet.addRow({
        projectNumber: deal.project?.number ?? '',
        projectName: deal.project?.name ?? '',
        title: deal.title,
        stage: DEAL_STAGE_LABELS[deal.stage],
        company: deal.company?.name ?? '',
        contact: deal.contact ? contactDisplayName(deal.contact) : '',
        email: deal.contact?.email ?? '',
        phone: deal.contact?.phone ?? '',
        owner: deal.owner.displayName,
        nextAction: deal.nextAction ?? '',
        dueDate: deal.dueDate ? formatDate(deal.dueDate) : '',
        lastContact: deal.lastContactAt ? formatDate(deal.lastContactAt) : '',
        daysSilent: deal.lastOutboundAt && !deal.lastInboundAt ? daysSince(deal.lastOutboundAt) : '',
        reasons: deal.openReasons.join('; '),
      });
    }

    styleSheet(sheet);
    return sendWorkbook(reply, workbook, `offene-vorgaenge-${today()}.xlsx`);
  });

  /** Projektliste mit Beteiligten – die Übersicht für die Bauleitung. */
  app.get('/api/export/projects.xlsx', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const visibility = await projectVisibilityFilter(user);

    const projects = await prisma.project.findMany({
      where: { AND: [visibility, { archivedAt: null }] },
      include: {
        leadUser: { select: { displayName: true } },
        company: { select: { name: true } },
        contacts: { include: { contact: true, company: { select: { name: true } } } },
        members: { include: { user: { select: { displayName: true } } } },
        _count: { select: { deals: true, activities: true } },
      },
      orderBy: { number: 'desc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AI Sales Acquisition System';

    const overview = workbook.addWorksheet('Projekte');
    overview.columns = [
      { header: 'Nummer', key: 'number', width: 14 },
      { header: 'Projekt', key: 'name', width: 40 },
      { header: 'Phase', key: 'stage', width: 20 },
      { header: 'Ort', key: 'city', width: 22 },
      { header: 'Auftraggeber', key: 'client', width: 28 },
      { header: 'Projektleitung', key: 'lead', width: 22 },
      { header: 'Team', key: 'team', width: 34 },
      { header: 'Beteiligte', key: 'contactCount', width: 12 },
      { header: 'Vorgänge', key: 'dealCount', width: 12 },
      { header: 'Letzte Aktivität', key: 'lastActivity', width: 18 },
    ];

    for (const project of projects) {
      overview.addRow({
        number: project.number,
        name: project.name,
        stage: PROJECT_STAGE_LABELS[project.stage],
        city: [project.postalCode, project.city].filter(Boolean).join(' '),
        client: project.company?.name ?? '',
        lead: project.leadUser.displayName,
        team: project.members.map((m) => m.user.displayName).join(', '),
        contactCount: project.contacts.length,
        dealCount: project._count.deals,
        lastActivity: project.lastActivityAt ? formatDate(project.lastActivityAt) : '',
      });
    }
    styleSheet(overview);

    const participants = workbook.addWorksheet('Beteiligte');
    participants.columns = [
      { header: 'Projekt-Nr.', key: 'number', width: 14 },
      { header: 'Projekt', key: 'project', width: 32 },
      { header: 'Rolle', key: 'role', width: 26 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Firma', key: 'company', width: 28 },
      { header: 'E-Mail', key: 'email', width: 32 },
      { header: 'Telefon', key: 'phone', width: 18 },
      { header: 'Letzter Kontakt', key: 'lastContact', width: 16 },
      { header: 'Quelle', key: 'source', width: 18 },
    ];

    for (const project of projects) {
      for (const pc of project.contacts) {
        participants.addRow({
          number: project.number,
          project: project.name,
          role: pc.roleDetail ?? PROJECT_CONTACT_ROLE_LABELS[pc.role],
          name: contactDisplayName(pc.contact),
          company: pc.company?.name ?? '',
          email: pc.contact.email,
          phone: pc.contact.phone ?? '',
          lastContact: pc.lastContactAt ? formatDate(pc.lastContactAt) : '',
          source: pc.autoDetected ? 'aus Mailverkehr erkannt' : 'gepflegt',
        });
      }
    }
    styleSheet(participants);

    return sendWorkbook(reply, workbook, `projekte-${today()}.xlsx`);
  });
}

function styleSheet(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF3' } };
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };
}

async function sendWorkbook(
  reply: FastifyReply,
  workbook: ExcelJS.Workbook,
  filename: string,
): Promise<FastifyReply> {
  const buffer = await workbook.xlsx.writeBuffer();
  return reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(Buffer.from(buffer));
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('de-DE');
}

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400_000);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
