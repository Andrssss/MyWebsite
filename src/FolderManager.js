export default class FolderManager {




    constructor(apiEndpoint) {
      this.apiEndpoint = apiEndpoint;
    }
  
    async getFolders(path = '') {
      try {
        console.log('Fetching path:', path); // Ellenőrizd az elküldött útvonalat
        const response = await fetch(`http://localhost:5000/api/files?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        return data.files;
      } catch (error) {
        console.error('Hiba a mappák betöltésekor:', error);
        return [];
      }
    }
    
  }
  