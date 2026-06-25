export interface DomainImage {
  url?: string;
  absolutePath?: string;
  filename?: string;
  legacy?: boolean;
}

export interface DomainTask {
  id: string;
  displayId?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  images: DomainImage[];
  [key: string]: unknown;
}

export function toDomainTask(dto: any): DomainTask {
  const images: DomainImage[] = [];
  if (dto?.designImage) {
    images.push({ url: dto.designImage, legacy: true });
  }
  if (Array.isArray(dto?.designImages)) {
    for (const url of dto.designImages) {
      if (url) images.push({ url, legacy: true });
    }
  }
  if (Array.isArray(dto?.images)) {
    for (const img of dto.images) {
      if (img) images.push(img);
    }
  }
  const { designImage, designImages, ...rest } = dto || {};
  return { ...rest, images } as DomainTask;
}

export function toDtoTask(domain: DomainTask): any {
  const legacyUrls = domain.images.filter((i) => i.legacy).map((i) => i.url).filter(Boolean) as string[];
  const nativeImages = domain.images.filter((i) => !i.legacy);
  return {
    ...domain,
    designImage: legacyUrls[0],
    designImages: legacyUrls.slice(1),
    images: nativeImages,
  };
}
