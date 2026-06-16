// Office geofence configuration. Overridable via env so the location/radius can be
// tuned without a code change. Defaults point to Perfect Neighbourhood LLP, Bengaluru.
const OFFICE = {
  lat: Number(process.env.OFFICE_LAT) || 13.0076905,
  lng: Number(process.env.OFFICE_LNG) || 77.6598877,
  radiusMeters: Number(process.env.OFFICE_RADIUS_M) || 200,
};

// Great-circle (Haversine) distance in metres between two GPS coordinates.
function distanceMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(Number(v)))) {
    return null;
  }
  const R = 6371000; // Earth radius in metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Distance of a punch from the office, and whether it's inside the geofence radius.
function evaluateAgainstOffice(lat, lng) {
  const distance = distanceMeters(lat, lng, OFFICE.lat, OFFICE.lng);
  return {
    distance,
    within: distance != null && distance <= OFFICE.radiusMeters,
  };
}

module.exports = { OFFICE, distanceMeters, evaluateAgainstOffice };
