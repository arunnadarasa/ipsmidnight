/**
 * Age assurance without shipping a birth date.
 *
 * Name + date of birth is the standard re-identification pair for health data,
 * so credentials carry a derived boolean instead of the raw `birthDate` taken
 * from the FHIR Patient resource.
 */
export function isOver18(birthDate: string, now = new Date()): boolean {
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return false;
  const eighteenth = new Date(dob);
  eighteenth.setFullYear(eighteenth.getFullYear() + 18);
  return eighteenth.getTime() <= now.getTime();
}
