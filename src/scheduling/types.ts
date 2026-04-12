export interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  meetLink?: string;
}

export interface CreateEventParams {
  summary: string;
  description?: string;
  startDateTime: string; // ISO 8601
  endDateTime: string;   // ISO 8601
}

export interface UpdateEventParams {
  summary?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface AvailableSlot {
  date: Date;
  time: string;
  formatted: string; // "Segunda-feira (DD/MM) às HHh"
}
