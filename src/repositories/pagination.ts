export interface PageParams {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export const toSkipTake = ({ page, pageSize }: PageParams) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});
