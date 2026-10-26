export function Attribution() {
  return (
    <p className="attrib small muted">
      Map data ©{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        OpenStreetMap contributors
      </a>
      , available under the Open Database Licence (ODbL). Searches use the public Overpass API.
      Businesses missing from the results may simply be missing from OpenStreetMap.
    </p>
  );
}
