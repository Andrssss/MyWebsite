export default class FolderManager {
  constructor(apiEndpoint) {
      this.apiEndpoint = apiEndpoint;
  }

  async getFolders(path = '') {
      try {
          console.log('Fetching path:', path);
          const response = await fetch(`${this.apiEndpoint}?path=${encodeURIComponent(path)}`);
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