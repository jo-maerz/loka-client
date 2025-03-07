import { Component, OnInit, OnDestroy, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import * as L from 'leaflet';
import { Experience, ExperienceImage } from '../../models/experience.model';
import { Subscription } from 'rxjs';
import {
  FormGroup,
  FormBuilder,
  Validators,
  FormControl,
  AbstractControl,
  ValidationErrors,
  FormGroupDirective,
  NgForm,
} from '@angular/forms';
import {
  debounceTime,
  distinctUntilChanged,
  switchMap,
  catchError,
} from 'rxjs/operators';
import { of } from 'rxjs';
import { GeocodeResult, MapService } from '../../services/map.service';
import { ErrorStateMatcher } from '@angular/material/core';

export function dateRangeValidator(
  formGroup: AbstractControl
): ValidationErrors | null {
  const startDate = formGroup.get('startDateTime.date')?.value;
  const startTime = formGroup.get('startDateTime.time')?.value;
  const endDate = formGroup.get('endDateTime.date')?.value;
  const endTime = formGroup.get('endDateTime.time')?.value;

  if (!startDate || !startTime || !endDate || !endTime) {
    return null;
  }

  const start = combineDateTime(startDate, startTime);
  const end = combineDateTime(endDate, endTime);

  return end < start ? { invalidDateRange: true } : null;
}

function combineDateTime(dateValue: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  const combined = new Date(dateValue);
  combined.setHours(hours, minutes, 0, 0);
  return combined;
}

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'assets/marker-icon-2x.png',
  iconUrl: 'assets/marker-icon.png',
  shadowUrl: 'assets/marker-shadow.png',
});

export class DateRangeErrorStateMatcher implements ErrorStateMatcher {
  isErrorState(
    control: FormControl | null,
    form: FormGroupDirective | NgForm | null
  ): boolean {
    const isSubmitted = form && form.submitted;
    const controlInvalid = !!(
      control &&
      control.invalid &&
      (control.dirty || control.touched || isSubmitted)
    );
    const parent = control?.parent;
    const parentInvalid = !!(
      parent &&
      parent.parent &&
      parent.parent.hasError('invalidDateRange') &&
      (parent.dirty || parent.touched || isSubmitted)
    );
    return controlInvalid || parentInvalid;
  }
}

@Component({
  selector: 'app-create-experience-modal',
  templateUrl: './create-experience-modal.component.html',
  styleUrls: ['./create-experience-modal.component.scss'],
})
export class CreateExperienceModalComponent implements OnInit, OnDestroy {
  selectMap!: L.Map;
  selectMarker: L.Marker | null = null;

  experienceForm!: FormGroup;
  loading: boolean = false;

  uploadedImages: ExperienceImage[] = [];

  dateRangeMatcher = new DateRangeErrorStateMatcher();

  private subscriptions: Subscription = new Subscription();

  constructor(
    public dialogRef: MatDialogRef<CreateExperienceModalComponent>,
    @Inject(MAT_DIALOG_DATA)
    public data: {
      experience?: Experience;
      city?: { name: string; lat: number; lng: number };
    },
    private mapService: MapService,
    private fb: FormBuilder
  ) {}

  ngOnInit(): void {
    this.initializeForm();
    this.initSelectMap();
    this.setupAddressAutoSearch();
  }

  ngOnDestroy(): void {
    if (this.selectMap) {
      this.selectMap.remove();
    }
    this.subscriptions.unsubscribe();
  }

  initializeForm(): void {
    const experience = this.data?.experience;
    this.experienceForm = this.fb.group(
      {
        name: [experience?.name || '', Validators.required],
        startDateTime: this.fb.group({
          date: [
            experience?.startDateTime
              ? new Date(experience.startDateTime)
              : null,
            Validators.required,
          ],
          time: [
            experience?.startDateTime
              ? this.formatTime(new Date(experience.startDateTime))
              : '00:00',
            Validators.required,
          ],
        }),
        endDateTime: this.fb.group({
          date: [
            experience?.endDateTime ? new Date(experience.endDateTime) : null,
            Validators.required,
          ],
          time: [
            experience?.endDateTime
              ? this.formatTime(new Date(experience.endDateTime))
              : '00:00',
            Validators.required,
          ],
        }),
        address: [experience?.address || '', Validators.required],
        description: [experience?.description || ''],
        hashtags: [experience?.hashtags ? experience.hashtags.join(' ') : ''],
        category: [experience?.category || '', Validators.required],
        images: [experience?.images || []],
        position: this.fb.group({
          lat: [
            experience?.position?.lat || this.data?.city?.lat || 50.1111,
            Validators.required,
          ],
          lng: [
            experience?.position?.lng || this.data?.city?.lng || 8.6821,
            Validators.required,
          ],
        }),
      },
      {
        validators: [dateRangeValidator],
      }
    );

    if (this.isEditMode() && experience?.position) {
      this.experienceForm.patchValue({
        address: experience.address,
        position: {
          lat: experience.position.lat,
          lng: experience.position.lng,
        },
      });
    }
  }

  isEditMode(): boolean {
    return !!this.data?.experience && this.data?.experience.id != null;
  }

  private formatTime(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  initSelectMap(): void {
    const position = this.data.experience?.position;
    const positionGroup = this.experienceForm.get('position') as FormGroup;
    const initialLat =
      positionGroup.get('lat')?.value || this.data?.city?.lat || 50.1111;
    const initialLng =
      positionGroup.get('lng')?.value || this.data?.city?.lng || 8.6821;

    this.selectMap = L.map('selectMap').setView([initialLat, initialLng], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.selectMap);

    if (this.isEditMode() && position && position.lat && position.lng) {
      this.addMarker(position.lat, position.lng);
    }

    this.selectMap.on('click', this.onSelectMapClick.bind(this));
  }

  setupAddressAutoSearch(): void {
    const addressControl = this.experienceForm.get('address') as FormControl;

    const addressSub = addressControl.valueChanges
      .pipe(
        debounceTime(1000),
        distinctUntilChanged(),
        switchMap((address: string) => {
          if (address && address.trim().length > 0) {
            this.loading = true;
            return this.mapService.geocodeAddress(address.trim()).pipe(
              catchError((error) => {
                this.loading = false;
                alert(error.message);
                return of([]);
              })
            );
          } else {
            this.loading = false;
            return of([]);
          }
        })
      )
      .subscribe({
        next: (results: GeocodeResult[]) => {
          this.loading = false;
          if (results && results.length > 0) {
            const firstResult = results[0];
            const lat = parseFloat(firstResult.lat);
            const lng = parseFloat(firstResult.lon);
            this.updatePosition(lat, lng, firstResult.display_name);
          } else if (addressControl.value.trim().length > 0) {
            alert('Address not found.');
          }
        },
        error: (error: Error) => {
          this.loading = false;
          alert(error.message);
        },
      });

    this.subscriptions.add(addressSub);
  }

  onSelectMapClick(event: L.LeafletMouseEvent): void {
    const { lat, lng } = event.latlng;
    this.addMarker(lat, lng);

    const reverseGeocodeSub = this.mapService
      .reverseGeocode(lat, lng)
      .subscribe({
        next: (address: string) => {
          this.experienceForm
            .get('address')
            ?.setValue(address, { emitEvent: false });
          this.updatePosition(lat, lng, address);
        },
        error: (error: Error) => {
          alert(error.message);
        },
      });

    this.subscriptions.add(reverseGeocodeSub);
  }

  addMarker(lat: number, lng: number): void {
    if (this.selectMarker) {
      this.selectMap.removeLayer(this.selectMarker);
      this.selectMarker = null;
    }
    this.selectMarker = L.marker([lat, lng]).addTo(this.selectMap);
  }

  updatePosition(lat: number, lng: number, address: string): void {
    // Update the position in the form.
    const positionGroup = this.experienceForm.get('position') as FormGroup;
    positionGroup.patchValue({ lat, lng });
    this.experienceForm.patchValue({ address });

    if (this.selectMarker) {
      this.selectMap.removeLayer(this.selectMarker);
    }
    this.selectMarker = L.marker([lat, lng]).addTo(this.selectMap);
    this.selectMap.setView([lat, lng], 14);
  }

  handleFileUpload(event: Event): void {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (!files) return;

    const currentImages = this.experienceForm.get('images')?.value || [];

    if (currentImages.length + files.length > 10) {
      alert('You can upload up to 10 images.');
      return;
    }

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e: ProgressEvent<FileReader>) => {
        currentImages.push({
          preview: e.target?.result?.toString(),
          file: file,
        });
        this.experienceForm.get('images')?.setValue(currentImages);
      };
      reader.readAsDataURL(file);
    });
  }

  submitExperience(): void {
    if (this.experienceForm.invalid) {
      this.experienceForm.markAllAsTouched();
      if (this.experienceForm.errors?.['invalidDateRange']) {
        alert('End date/time must be after Start date/time.');
      } else {
        alert('Please fill in all required fields correctly.');
      }
      return;
    }

    const startDateTime = this.getCombinedDateTime('startDateTime');
    const endDateTime = this.getCombinedDateTime('endDateTime');

    const hashtagsInput = this.experienceForm.get('hashtags')?.value || '';
    const hashtags = hashtagsInput
      .split(' ')
      .filter((tag: string) => tag.startsWith('#') && tag.length > 1);

    const positionGroup = this.experienceForm.get('position') as FormGroup;
    const position = {
      lat: positionGroup.get('lat')?.value,
      lng: positionGroup.get('lng')?.value,
    };

    const experience: Experience = {
      id: this.data.experience?.id,
      name: this.experienceForm.get('name')?.value,
      startDateTime: new Date(startDateTime),
      endDateTime: new Date(endDateTime),
      address: this.experienceForm.get('address')?.value,
      position: position,
      description: this.experienceForm.get('description')?.value,
      hashtags: hashtags,
      category: this.experienceForm.get('category')?.value,
      city: this.data.city?.name,
    };

    const filesToUpload = this.experienceForm
      .get('images')
      ?.value?.map((img: ExperienceImage) => img.file);

    this.dialogRef.close({
      experience: experience,
      files: filesToUpload,
    });

    this.resetForm();
  }

  private getCombinedDateTime(
    groupName: 'startDateTime' | 'endDateTime'
  ): string {
    const group = this.experienceForm.get(groupName) as FormGroup;
    const date: Date = group.get('date')?.value;
    const time: string = group.get('time')?.value;
    if (!date || !time) return new Date().toISOString();

    const [hours, minutes] = time.split(':').map(Number);
    const combinedDate = new Date(date);
    combinedDate.setHours(hours, minutes, 0, 0);
    return combinedDate.toISOString();
  }

  resetForm(): void {
    this.experienceForm.reset({
      name: '',
      startDateTime: { date: null, time: '00:00' },
      endDateTime: { date: null, time: '00:00' },
      address: '',
      description: '',
      hashtags: '',
      category: '',
      images: [],
      position: {
        lat: this.data?.city?.lat || 50.1111,
        lng: this.data?.city?.lng || 8.6821,
      },
    });
    this.uploadedImages = [];
    if (this.selectMarker) {
      this.selectMap.removeLayer(this.selectMarker);
      this.selectMarker = null;
    }
    // Reset the map view to default.
    this.selectMap.setView([50.11111, 8.6821], 14);
  }
}
