import { Component, OnInit } from '@angular/core';
import { GridColumn } from '@ng-matero/extensions/data-grid';

const ELEMENT_DATA: any[] = [
  {
    position: 1,
    name: 'Hydrogen',
    tag: [
      {
        color: 'red',
        value: [1, 2],
      },
    ],
    weight: 1.0079,
    symbol: 'H',
    gender: 'male',
    mobile: '13198765432',
    tele: '80675432',
    city: 'New York',
    address: '555 Lexington Avenue',
    date: '1423456765768',
    website: 'www.matero.com',
    company: 'matero',
    email: 'Hydrogen@gmail.com',
  },
  {
    position: 2,
    name: 'Helium',
    tag: [
      {
        color: 'blue',
        value: [3, 4],
      },
    ],
    weight: 4.0026,
    symbol: 'He',
    gender: 'male',
    mobile: '13034676675',
    tele: '80675432',
    city: 'Shanghai',
    address: '88 Songshan Road',
    date: '1423456765768',
    website: 'www.matero.com',
    company: 'matero',
    email: 'Helium@gmail.com',
  },
];

@Component({
  selector: 'app-data-grid-demo',
  templateUrl: './data-grid-demo.component.html',
  styleUrls: ['./data-grid-demo.component.scss'],
})
export class DataGridDemoComponent implements OnInit {
  columns: GridColumn[] = [
    {
      title: 'Select',
      index: 'select',
      type: 'checkbox',
      fixed: 'left',
      width: '30px',
    },
    {
      title: 'Position',
      index: 'position',
      width: 'auto',
      sort: true,
    },
    {
      title: 'Name',
      index: 'name',
      width: 'auto',
      sort: true,
    },
    {
      title: 'tags',
      index: 'tag.0.value',
      width: 'auto',
    },
    {
      title: 'Weight',
      index: 'weight',
      width: 'auto',
      type: 'format',
      format: (data: any) => {
        return data.weight * 100;
      },
    },
    {
      title: 'Symbol',
      index: 'symbol',
      width: 'auto',
    },
    {
      title: 'Gender',
      index: 'gender',
      width: 'auto',
    },
    {
      title: 'Mobile',
      index: 'mobile',
      width: 'auto',
    },
    {
      title: 'Tele',
      index: 'tele',
      width: 'auto',
    },
    {
      title: 'City',
      index: 'city',
      width: 'auto',
    },
    {
      title: 'Address',
      index: 'address',
      width: '200px',
    },
    {
      title: 'Date',
      index: 'date',
      width: 'auto',
    },
    {
      title: 'Website',
      index: 'website',
      width: 'auto',
    },
    {
      title: 'Company',
      index: 'company',
      width: 'auto',
    },
    {
      title: 'Email',
      index: 'email',
      width: 'auto',
    },
  ];
  list = ELEMENT_DATA;
  isLoading = false;
  constructor() {}

  ngOnInit() {}
}
