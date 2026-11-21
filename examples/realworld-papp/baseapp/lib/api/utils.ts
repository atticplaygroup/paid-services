import slug from 'slug';
export default class Utility {
  static slugify = (title: string): string => `${slug(title, { lower: true })}-${((Math.random() * Math.pow(36, 6)) | 0).toString(36)}`;
  static wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
}
