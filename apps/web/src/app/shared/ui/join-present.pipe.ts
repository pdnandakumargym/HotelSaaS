import { Pipe, PipeTransform } from '@angular/core';

/** Joins the non-empty values: ['Chennai', null, 'IN'] | joinPresent -> "Chennai, IN". */
@Pipe({ name: 'joinPresent' })
export class JoinPresentPipe implements PipeTransform {
  transform(values: readonly (string | null | undefined)[], separator = ', '): string {
    return values.filter((v): v is string => !!v && v.trim() !== '').join(separator);
  }
}
