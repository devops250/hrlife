import { google } from 'googleapis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import { getAuthenticatedClient } from './google-oauth';
import type { CalendarEvent, CreateEventParams, UpdateEventParams } from './types';

async function getCalendar() {
  const auth = await getAuthenticatedClient();
  return google.calendar({ version: 'v3', auth });
}

export async function listEvents(startDate: Date, endDate: Date): Promise<CalendarEvent[]> {
  return retry(
    async () => {
      const calendar = await getCalendar();
      const res = await calendar.events.list({
        calendarId: env.GOOGLE_CALENDAR_ID,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return (res.data.items || [])
        .filter((item) => item.status !== 'cancelled')
        .map((item) => ({
          id: item.id || '',
          summary: item.summary || '',
          start: new Date(item.start?.dateTime || item.start?.date || ''),
          end: new Date(item.end?.dateTime || item.end?.date || ''),
          meetLink: item.hangoutLink || undefined,
          status: item.status || 'confirmed',
        }));
    },
    { label: 'calendar.listEvents' },
  );
}

export async function createEvent(params: CreateEventParams): Promise<CalendarEvent> {
  return retry(
    async () => {
      const calendar = await getCalendar();
      const res = await calendar.events.insert({
        calendarId: env.GOOGLE_CALENDAR_ID,
        conferenceDataVersion: 1,
        requestBody: {
          summary: params.summary,
          description: params.description,
          start: {
            dateTime: params.startDateTime,
            timeZone: 'America/Sao_Paulo',
          },
          end: {
            dateTime: params.endDateTime,
            timeZone: 'America/Sao_Paulo',
          },
          conferenceData: {
            createRequest: {
              requestId: `hrlife-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        },
      });

      const event: CalendarEvent = {
        id: res.data.id || '',
        summary: res.data.summary || '',
        start: new Date(res.data.start?.dateTime || ''),
        end: new Date(res.data.end?.dateTime || ''),
        meetLink: res.data.hangoutLink || undefined,
        status: res.data.status || 'confirmed',
      };

      logger.info('Evento criado no Google Calendar', {
        eventId: event.id,
        summary: event.summary,
        meetLink: event.meetLink,
      });

      return event;
    },
    { label: 'calendar.createEvent' },
  );
}

export async function deleteEvent(eventId: string): Promise<void> {
  return retry(
    async () => {
      const calendar = await getCalendar();
      await calendar.events.delete({
        calendarId: env.GOOGLE_CALENDAR_ID,
        eventId,
      });
      logger.info('Evento deletado do Google Calendar', { eventId });
    },
    { label: 'calendar.deleteEvent' },
  );
}

export async function updateEvent(eventId: string, params: UpdateEventParams): Promise<CalendarEvent> {
  return retry(
    async () => {
      const calendar = await getCalendar();

      const body: Record<string, unknown> = {};
      if (params.summary) body.summary = params.summary;
      if (params.startDateTime) {
        body.start = { dateTime: params.startDateTime, timeZone: 'America/Sao_Paulo' };
      }
      if (params.endDateTime) {
        body.end = { dateTime: params.endDateTime, timeZone: 'America/Sao_Paulo' };
      }

      const res = await calendar.events.patch({
        calendarId: env.GOOGLE_CALENDAR_ID,
        eventId,
        requestBody: body,
      });

      const event: CalendarEvent = {
        id: res.data.id || '',
        summary: res.data.summary || '',
        start: new Date(res.data.start?.dateTime || ''),
        end: new Date(res.data.end?.dateTime || ''),
        meetLink: res.data.hangoutLink || undefined,
        status: res.data.status || 'confirmed',
      };

      logger.info('Evento atualizado no Google Calendar', { eventId: event.id });
      return event;
    },
    { label: 'calendar.updateEvent' },
  );
}

export async function checkFreeBusy(startDate: Date, endDate: Date): Promise<Array<{ start: Date; end: Date }>> {
  return retry(
    async () => {
      const calendar = await getCalendar();
      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          timeZone: 'America/Sao_Paulo',
          items: [{ id: env.GOOGLE_CALENDAR_ID }],
        },
      });

      const busy = res.data.calendars?.[env.GOOGLE_CALENDAR_ID]?.busy || [];
      return busy.map((b) => ({
        start: new Date(b.start || ''),
        end: new Date(b.end || ''),
      }));
    },
    { label: 'calendar.checkFreeBusy' },
  );
}

export async function findEventByLeadName(leadName: string): Promise<CalendarEvent | null> {
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 dias
  const events = await listEvents(now, future);
  const searchTerm = `HR Life - ${leadName}`;
  return events.find((e) => e.summary.includes(searchTerm)) || null;
}
