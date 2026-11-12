/**
 * The crew: terminals as faces, who drives them as a seat. Shared by the
 * Terminal window's rail and header, floating terminals and the chat card.
 */

export type { CrewPerson, FaceState, SeatState, SeatView } from "./crewModel"
export {
  describeSeat,
  elapsed,
  faceColors,
  faceState,
  normalizeWatchers,
  personColor,
  resolveDriver,
  SEAT_COLORS,
  seatColor,
} from "./crewModel"
export type { DriverLine } from "./driverLabel"
export { driverLabel, driverLine } from "./driverLabel"
export { Face } from "./Face"
export { PersonAvatar, Seat, WheelIcon } from "./Seat"
